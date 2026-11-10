import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { analysisContextLimits } from '../shared/schema.js';
import {
  compactText,
  selectBridgeMessages,
  selectDecisionEvidence,
  compactSignals,
  selectDuplicateMemories,
  selectRelatedTraits,
} from './context-selection.js';
import type { ImageAnalysisService } from './image-analysis.js';
import type { ImageEvidence } from '../shared/schema.js';
import { Store } from './store.js';
import { ImageContextError } from './ai-context.js';
import {
  prompts,
  AiCallError,
  summaryResultSchema,
  gateResultSchema,
  adviceResultSchema,
  consolidationSchema,
  type AiClient,
} from './ai.js';
import type { ProgressEvent } from './progress.js';
import type {
  AnalysisRun,
  ActivityStep,
  Contact,
  Conversation,
  Message,
  Memory,
} from '../shared/schema.js';

type AnalysisStage = '摘要更新' | '建议必要性判断' | '详细建议生成' | '画像与记忆归纳';
class AnalysisFailure extends Error {}

interface ConversationWork {
  run?: AnalysisRun;
  controller?: AbortController;
  debounce?: ReturnType<typeof setTimeout>;
  idle?: ReturnType<typeof setTimeout>;
  summaryIdle?: ReturnType<typeof setTimeout>;
  consolidationIdle?: ReturnType<typeof setTimeout>;
  queuedTriggers?: string[];
}
export function retrieveMemories(memories: Memory[], keywords: string[], now: number): Memory[] {
  const terms = keywords.map((term) => term.toLocaleLowerCase()).filter(Boolean);
  return memories
    .map((memory) => {
      const searchable = `${memory.text} ${memory.keywords.join(' ')}`.toLocaleLowerCase();
      const matches = terms.filter((term) => searchable.includes(term)).length;
      const ageDays = Math.max(0, now - memory.time) / 86400000;
      return { memory, score: matches / (1 + ageDays / 90) };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 8)
    .map((item) => item.memory);
}

/** Owns independent stage timers and serial AI tasks. Abort + identity guards reject stale responses. */
export class AnalysisEngine {
  private readonly work = new Map<string, ConversationWork>();
  private readonly tasks = new Set<Promise<void>>();
  private stopped = false;
  private readonly runs = new Map<string, AnalysisRun[]>();
  constructor(
    private readonly store: Store,
    private readonly ai: AiClient,
    private readonly changed: () => void,
    private readonly images?: ImageAnalysisService,
  ) {}

  activity(id: string): AnalysisRun[] {
    return (this.runs.get(id) ?? []).map((run) => ({
      ...run,
      steps: run.steps.map((step) => ({ ...step })),
    }));
  }
  private createRun(id: string, trigger: string): AnalysisRun {
    const run: AnalysisRun = {
      id: randomUUID(),
      trigger,
      status: 'waiting',
      detail: '',
      startedAt: Date.now(),
      steps: [],
    };
    this.runs.set(id, [...(this.runs.get(id) ?? []), run].slice(-5));
    return run;
  }
  private appendStep(run: AnalysisRun, step: ActivityStep): void {
    run.steps.push(step);
    if (run.steps.length > 80) {
      const removable = run.steps.findIndex((item) => item.status !== 'running');
      if (removable >= 0) run.steps.splice(removable, 1);
    }
    this.changed();
  }
  private beginStep(
    id: string,
    kind: ActivityStep['kind'],
    label: string,
  ): (detail?: string) => void {
    const run = this.work.get(id)?.run;
    if (!run || !['waiting', 'running'].includes(run.status)) return () => {};
    const step: ActivityStep = {
      id: randomUUID(),
      kind,
      label,
      status: 'running',
      detail: '',
      startedAt: Date.now(),
    };
    this.appendStep(run, step);
    return (detail = '') => {
      if (step.status !== 'running' || !['waiting', 'running'].includes(run.status)) return;
      step.status = 'completed';
      step.detail = detail;
      step.finishedAt = Date.now();
      this.changed();
    };
  }
  private skip(id: string, label: string, detail: string): void {
    const run = this.work.get(id)?.run;
    if (run?.status === 'running')
      this.appendStep(run, {
        id: randomUUID(),
        kind: 'schedule',
        label,
        status: 'skipped',
        detail,
        startedAt: Date.now(),
        finishedAt: Date.now(),
      });
  }
  private finishRun(
    run: AnalysisRun | undefined,
    status: 'completed' | 'cancelled' | 'failed',
    detail: string,
  ): void {
    if (!run || !['waiting', 'running'].includes(run.status)) return;
    run.status = status;
    run.detail = detail;
    run.finishedAt = Date.now();
    for (const step of run.steps) {
      if (step.status === 'running') {
        step.status = status;
        step.finishedAt = run.finishedAt;
        if (status !== 'completed') step.detail = detail;
      }
    }
    this.changed();
  }
  private reportProgress(run: AnalysisRun, event: ProgressEvent): void {
    const existing = run.steps.find((step) => step.id === event.id);
    if (existing) {
      existing.status = event.status;
      existing.detail = event.detail;
      if (event.status === 'completed') existing.finishedAt = Date.now();
      this.changed();
    } else
      this.appendStep(run, {
        ...event,
        startedAt: Date.now(),
        ...(event.status === 'completed' ? { finishedAt: Date.now() } : {}),
      });
  }
  private active(id: string): { conversation: Conversation; contact: Contact } | undefined {
    if (this.stopped) return;
    const conversation = this.store.conversation(id);
    const contact = conversation ? this.store.contact(conversation.contactId) : undefined;
    if (!conversation || !contact || contact.paused || conversation.paused) return;
    return { conversation, contact };
  }
  private participants(contact: Contact) {
    return {
      self: {
        qq: this.store.settings.selfQq,
        name: this.store.self.name,
        aliases: this.store.self.aliases,
      },
      contact: { id: contact.id, qq: contact.qq, name: contact.name },
    };
  }
  private attributedMessages(messages: Message[], contact: Contact) {
    return messages.map((message) => ({
      ...message,
      senderRole:
        message.senderId === this.store.settings.selfQq
          ? 'self'
          : message.senderId === contact.qq
            ? 'contact'
            : 'other',
    }));
  }
  notify(id: string, live = true): void {
    this.cancel(id, live ? '收到新消息，旧任务已取消' : '历史或配置更新，重新安排分析');
    if (!this.active(id)) return;
    const work: ConversationWork = { run: this.createRun(id, live ? '消息更新' : '历史归纳') };
    this.work.set(id, work);
    this.beginStep(id, 'schedule', '等待消息合并');
    const { conversation } = this.active(id)!;
    const settings = this.store.settings;
    const thresholdReached =
      this.store.pendingMessageCount(id, conversation.processedSequence) >=
        settings.summaryMessageThreshold ||
      this.store.pendingMessageCount(id, conversation.lastDecisionSequence, true) >=
        settings.messageThreshold ||
      this.store.pendingMessageCount(id, conversation.consolidatedSequence) >=
        settings.consolidationMessageThreshold;
    work.debounce = setTimeout(
      () => this.launch(id, '消息更新'),
      thresholdReached ? 0 : settings.mergeWindowSeconds * 1000,
    );
    work.summaryIdle = setTimeout(
      () => this.launch(id, '摘要静默'),
      settings.summaryIdleSeconds * 1000,
    );
    work.idle = setTimeout(() => this.launch(id, '对话静默'), settings.idleSeconds * 1000);
    work.consolidationIdle = setTimeout(
      () => this.launch(id, '归纳静默'),
      settings.consolidationIdleSeconds * 1000,
    );
  }

  flush(id: string): void {
    this.cancel(id, '用户发起重新检查');
    if (this.active(id)) this.launch(id, '手动检查');
  }
  cancel(id: string, reason = '任务已取消（暂停或调度更新）'): void {
    const work = this.work.get(id);
    work?.controller?.abort();
    this.finishRun(work?.run, 'cancelled', reason);
    clearTimeout(work?.debounce);
    clearTimeout(work?.idle);
    clearTimeout(work?.summaryIdle);
    clearTimeout(work?.consolidationIdle);
    this.work.delete(id);
  }
  private launch(id: string, trigger: string): void {
    const work = this.work.get(id) ?? {};
    if (work.run?.status === 'running') {
      work.queuedTriggers = [...(work.queuedTriggers ?? []), trigger];
      return;
    }
    if (!work.run || work.run.status !== 'waiting') work.run = this.createRun(id, trigger);
    const run = work.run;
    for (const step of run.steps) {
      if (step.status === 'running') {
        step.status = 'completed';
        step.finishedAt = Date.now();
      }
    }
    run.status = 'running';
    run.trigger = trigger;
    clearTimeout(work.debounce);
    const controller = new AbortController();
    work.controller = controller;
    this.work.set(id, work);
    this.changed();
    const task = this.run(id, trigger, controller)
      .then(() => {
        if (this.valid(id, controller)) this.finishRun(run, 'completed', '本轮执行完成');
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || !this.active(id)) return;
        const conversation = this.store.conversation(id)!;
        this.store.saveConversation({
          ...conversation,
          status: '分析失败',
          error:
            error instanceof AnalysisFailure
              ? error.message
              : '分析失败（步骤：处理或保存结果）。本阶段未完成，请点击重新检查；若持续失败，请检查本地服务状态。',
        });
        this.finishRun(run, 'failed', this.store.conversation(id)!.error);
        this.changed();
      })
      .finally(() => {
        this.tasks.delete(task);
        if (this.valid(id, controller)) {
          const next = work.queuedTriggers?.shift();
          if (next) this.launch(id, next);
        }
      });
    this.tasks.add(task);
  }
  private valid(id: string, controller: AbortController): boolean {
    return (
      !controller.signal.aborted &&
      this.work.get(id)?.controller === controller &&
      this.active(id) !== undefined
    );
  }
  private async callAi<T>(
    id: string,
    stage: AnalysisStage,
    instruction: string,
    context: unknown,
    schema: z.ZodType<T>,
    controller: AbortController,
    captureImages?: (evidence: ImageEvidence[]) => void,
  ): Promise<T> {
    const run = this.work.get(id)?.run;
    const complete = this.beginStep(id, 'ai', stage);
    try {
      const report = (event: ProgressEvent) => {
        if (run && this.valid(id, controller)) this.reportProgress(run, event);
      };
      const prepared = this.images
        ? await this.images.prepareContext(context, controller.signal, report)
        : { context, imageEvidence: [] };
      controller.signal.throwIfAborted();
      captureImages?.(prepared.imageEvidence);
      const result = await this.ai.call(
        instruction,
        prepared.context,
        schema,
        controller.signal,
        report,
      );
      complete();
      return result;
    } catch (error) {
      if (error instanceof AiCallError)
        throw new AnalysisFailure(`${stage}失败（步骤：${error.step}）：${error.message}`);
      if (error instanceof ImageContextError)
        throw new AnalysisFailure(`${stage}失败（步骤：读取消息图片）：${error.message}`);
      if (error instanceof z.ZodError)
        throw new AnalysisFailure(
          `${stage}失败（步骤：校验模型输出）：输出字段缺失或不符合要求，请重新检查。`,
        );
      // Unknown errors may include chat or credentials. Never display their raw messages.
      throw new AnalysisFailure(
        `${stage}失败（步骤：AI 调用）：请求未能完成，请重新检查；若持续失败，请检查服务连接和模型兼容性。`,
      );
    }
  }
  private async run(
    id: string,
    initialTrigger: string,
    controller: AbortController,
  ): Promise<void> {
    let significant = false;
    const initial = this.active(id)!;
    const settings = this.store.settings;
    const manual = initialTrigger === '手动检查';
    const decisionDue =
      manual ||
      initialTrigger === '对话静默' ||
      this.store.pendingMessageCount(id, initial.conversation.lastDecisionSequence, true) >=
        settings.messageThreshold;
    const consolidationDue =
      manual ||
      initialTrigger === '归纳静默' ||
      this.store.pendingMessageCount(id, initial.conversation.consolidatedSequence) >=
        settings.consolidationMessageThreshold;
    const summaryDue =
      decisionDue ||
      consolidationDue ||
      initialTrigger === '摘要静默' ||
      this.store.pendingMessageCount(id, initial.conversation.processedSequence) >=
        settings.summaryMessageThreshold;
    if (!summaryDue) this.skip(id, '摘要更新', '尚未达到摘要累计条数或静默时间');
    while (summaryDue && this.valid(id, controller)) {
      const current = this.active(id)!;
      const messagesRead = this.beginStep(id, 'tool', '读取待处理消息');
      const pending = this.store.pendingMessages(id, current.conversation.processedSequence);
      messagesRead(`本批 ${pending.length} 条消息`);
      if (pending.length === 0) break;
      this.store.saveConversation({ ...current.conversation, status: '摘要分析中', error: '' });
      this.changed();
      const previousSummary = compactText(
        current.conversation.summary,
        analysisContextLimits.legacySummaryCharacters,
      );
      const retainedCharacters = Math.min(
        analysisContextLimits.retainedSummaryCharacters,
        Math.floor(previousSummary.length * analysisContextLimits.summaryRetentionRatio),
      );
      const context = {
        participants: this.participants(current.contact),
        contact: { id: current.contact.id, qq: current.contact.qq, name: current.contact.name },
        kind: current.conversation.kind,
        previousSummary,
        summaryBudget: {
          retainedCharacters,
          currentCharacters: analysisContextLimits.currentSummaryCharacters,
          totalCharacters: analysisContextLimits.summaryCharacters,
        },
        recentContext: this.attributedMessages(
          selectBridgeMessages(
            this.store.messagesBeforeSequence(id, current.conversation.processedSequence, 24),
            pending,
            [this.store.settings.selfQq, current.contact.qq],
          ),
          current.contact,
        ),
        messages: this.attributedMessages(pending, current.contact),
        previousSignals: compactSignals(this.store.observations(id)),
      };
      const result = await this.callAi(
        id,
        '摘要更新',
        prompts.summary,
        context,
        summaryResultSchema.extend({
          compressedPreviousSummary: z.string().max(retainedCharacters),
        }),
        controller,
      );
      if (!this.valid(id, controller)) return;
      const relevant = current.conversation.kind === 'private' || result.relevant;
      significant ||= result.significant && relevant;
      const observationSaved = this.beginStep(id, 'storage', '保存态度与情绪分析');
      this.store.saveObservation({
        id: randomUUID(),
        conversationId: id,
        time: Date.now(),
        ...result,
        relevant,
        sourceIds: pending.map((message) => message.id),
      });
      observationSaved();
      if (!this.valid(id, controller)) return;
      const summarySaved = this.beginStep(id, 'storage', '保存当前摘要');
      const latest = this.store.conversation(id)!;
      this.store.saveConversation({
        ...latest,
        summary: relevant
          ? [result.compressedPreviousSummary.trim(), result.summary.trim()]
              .filter(Boolean)
              .join('\n')
          : latest.summary,
        processedSequence: pending.at(-1)!.sequence,
        status: '观察中',
        error: '',
      });
      this.changed();
      summarySaved();
    }
    if (!this.valid(id, controller)) return;
    await this.decide(id, initialTrigger, significant, controller);
    if (!this.valid(id, controller)) return;
    if (consolidationDue) await this.consolidatePending(id, controller);
    else this.skip(id, '画像与记忆归纳', '尚未达到归纳累计条数或静默时间');
  }
  private async decide(
    id: string,
    trigger: string,
    significant: boolean,
    controller: AbortController,
  ): Promise<void> {
    let relevant = this.store.observations(id).at(-1)?.relevant ?? false;
    const { conversation, contact } = this.active(id)!;
    const recent = this.store.messages(id, conversation.lastDecisionSequence, 200);
    if (conversation.kind === 'group') {
      const recentIds = new Set(recent.map((message) => message.id));
      relevant = this.store
        .observations(id)
        .some(
          (observation) =>
            observation.relevant &&
            observation.sourceIds.some((sourceId) => recentIds.has(sourceId)),
        );
    }
    const liveCount = recent.filter((message) => message.source === 'live').length;
    const threshold = liveCount >= this.store.settings.messageThreshold;
    const due = trigger === '对话静默' || trigger === '手动检查' || threshold || significant;
    if (!due || liveCount === 0) {
      this.skip(
        id,
        '建议判断',
        liveCount === 0 ? '历史消息仅更新摘要与记忆，不生成建议' : '尚未达到建议判断的触发条件',
      );
      return;
    }
    if (threshold) trigger = '消息数量阈值';
    if (significant) trigger = '明显态度/情绪变化';
    if (!relevant) {
      this.skip(id, '建议生成', '当前群聊未发现与用户有关的内容');
      this.recordDecision(
        id,
        false,
        '当前群聊未发现与用户有关的内容，不提供建议。',
        '',
        trigger,
        [],
      );
      return;
    }
    const observations = this.store.observations(id);
    const evidence = selectDecisionEvidence(recent, observations, [
      this.store.settings.selfQq,
      contact.qq,
    ]);
    const context = {
      participants: this.participants(contact),
      kind: conversation.kind,
      summary: compactText(conversation.summary, analysisContextLimits.summaryCharacters),
      messages: this.attributedMessages(evidence, contact),
      evidenceCoverage: {
        totalMessages: this.store.pendingMessageCount(id, conversation.lastDecisionSequence),
        selectedMessages: evidence.length,
        textIsExcerpted: true,
      },
      signals: compactSignals(observations),
    };
    const gate = await this.callAi(
      id,
      '建议必要性判断',
      prompts.gate,
      context,
      gateResultSchema,
      controller,
    );
    if (!this.valid(id, controller)) return;
    if (!gate.needed) {
      this.skip(id, '详细建议生成', '模型判断当前无需建议，原因已保存到判断记录');
      this.recordDecision(id, false, gate.reason, '', trigger, []);
    } else {
      const retrievalDone = this.beginStep(id, 'tool', '检索历史记忆');
      const memories = retrieveMemories(this.store.memories(contact.id), gate.keywords, Date.now());
      retrievalDone(`匹配 ${memories.length} 条历史记忆（含时间衰减排序）`);
      const result = await this.callAi(
        id,
        '详细建议生成',
        prompts.advice,
        {
          ...context,
          evidenceCoverage: {
            ...context.evidenceCoverage,
            selectedMessages: recent.length,
            textIsExcerpted: false,
          },
          self: this.store.self,
          contact,
          messages: this.attributedMessages(recent, contact),
          memories,
          gate,
        },
        adviceResultSchema,
        controller,
      );
      if (!this.valid(id, controller)) return;
      this.recordDecision(
        id,
        true,
        `${gate.reason}\n\n${result.analysis}`,
        result.advice,
        trigger,
        memories.map((memory) => memory.id),
      );
    }
  }

  private async consolidatePending(id: string, controller: AbortController): Promise<void> {
    while (this.valid(id, controller)) {
      const conversation = this.store.conversation(id)!;
      const pending = this.store
        .pendingMessages(id, conversation.consolidatedSequence)
        .filter((message) => message.sequence <= conversation.processedSequence);
      if (!pending.length) return;
      const relatedIds = new Set(
        this.store
          .observations(id)
          .filter((observation) => observation.relevant)
          .flatMap((observation) => observation.sourceIds),
      );
      const messages =
        conversation.kind === 'private'
          ? pending
          : pending.filter((message) => relatedIds.has(message.id));
      if (messages.length) await this.consolidate(id, messages, controller);
      if (!this.valid(id, controller)) return;
      this.store.saveConversation({
        ...this.store.conversation(id)!,
        consolidatedSequence: pending.at(-1)!.sequence,
      });
      this.changed();
    }
  }
  private recordDecision(
    id: string,
    needed: boolean,
    reason: string,
    advice: string,
    trigger: string,
    memoryIds: string[],
  ): void {
    const conversation = this.store.conversation(id)!;
    const decisionSaved = this.beginStep(id, 'storage', '保存建议判断');
    this.store.saveDecision({
      id: randomUUID(),
      conversationId: id,
      time: Date.now(),
      needed,
      reason,
      advice,
      trigger,
      memoryIds,
    });
    this.store.saveConversation({
      ...conversation,
      lastDecisionSequence: conversation.processedSequence,
      status: '观察中',
      error: '',
    });
    decisionSaved();
    this.changed();
  }
  private async consolidate(
    id: string,
    messages: Message[],
    controller: AbortController,
  ): Promise<void> {
    const { contact, conversation } = this.active(id)!;
    const traits = selectRelatedTraits(contact.traits, messages);
    const existingMemories = selectDuplicateMemories(
      this.store.memories(contact.id),
      messages,
      contact.id,
    ).map(({ id, kind, text, time }) => ({ id, kind, text, time }));
    let imageEvidence: ImageEvidence[] = [];
    const result = await this.callAi(
      id,
      '画像与记忆归纳',
      prompts.consolidate,
      {
        participants: this.participants(contact),
        contact: { id: contact.id, qq: contact.qq, name: contact.name },
        kind: conversation.kind,
        traits,
        messages: this.attributedMessages(messages, contact),
        existingMemories,
      },
      consolidationSchema,
      controller,
      (evidence) => {
        imageEvidence = evidence;
      },
    );
    if (!this.valid(id, controller)) return;
    const evidenceDone = this.beginStep(id, 'tool', '校验对象身份与消息证据');
    const available = new Map(messages.map((message) => [message.id, message]));
    const hasContactEvidence = (sourceIds: string[]) =>
      sourceIds.every((sourceId) => available.has(sourceId)) &&
      sourceIds.some((sourceId) => {
        const source = available.get(sourceId);
        return source?.senderId === contact.qq && source.senderId !== this.store.settings.selfQq;
      });
    // Validate the entire result before writing; failed attribution must remain retryable.
    const updatedTraits = { ...contact.traits };
    for (const field of ['likes', 'boundaries', 'communication'] as const) {
      const value = result.traits[field];
      if (value === undefined || value === contact.traits[field]) continue;
      if (traits[field] === undefined) {
        throw new AnalysisFailure(
          '画像与记忆归纳失败（步骤：画像证据校验）：模型修改了未提供的画像字段，本批结果未保存，请重新检查。',
        );
      }
      if (
        result.traits[field] !== contact.traits[field] &&
        !hasContactEvidence(result.traitSourceIds[field] ?? [])
      ) {
        const label = { likes: '喜好', boundaries: '忌讳与边界', communication: '沟通习惯' }[field];
        throw new AnalysisFailure(
          `画像与记忆归纳失败（步骤：画像证据校验）：“${label}”的修改缺少对象本人的有效消息证据。来源须来自本批消息，且至少包含对象本人发言。本批归纳结果未保存，请重新检查。`,
        );
      }
      updatedTraits[field] = value;
    }
    for (const memory of result.memories) {
      if (memory.subjectId !== contact.qq) {
        throw new AnalysisFailure(
          '画像与记忆归纳失败（步骤：记忆主体校验）：模型将事件记忆归属给了当前对象以外的人。本批归纳结果未保存，请重新检查。',
        );
      }
      if (!hasContactEvidence(memory.sourceIds)) {
        throw new AnalysisFailure(
          '画像与记忆归纳失败（步骤：记忆证据校验）：事件来源不属于本批消息，或未包含对象本人发言。本批归纳结果未保存，请重新检查。',
        );
      }
    }
    evidenceDone('画像和事件的对象归属与来源已校验');
    const saved = this.beginStep(id, 'storage', '保存画像与事件记忆');
    const latestContact = this.store.contact(contact.id)!;
    // User edits made during a request take precedence over its inferred trait snapshot.
    if (latestContact.traitsRevision === contact.traitsRevision) {
      this.store.saveContact({
        ...latestContact,
        traits: updatedTraits,
        traitsRevision: latestContact.traitsRevision + 1,
      });
    }
    for (const memory of result.memories) {
      const source = available.get(memory.sourceIds[0]!);
      if (!source) continue;
      const fingerprint = createHash('sha256')
        .update(`${contact.id}:${memory.kind}:${memory.sourceIds.slice().sort().join(',')}`)
        .digest('hex');
      this.store.saveMemory({
        ...memory,
        imageEvidence: imageEvidence.filter(
          (evidence) =>
            memory.sourceIds.includes(evidence.messageId) && evidence.conversationId === id,
        ),
        id: fingerprint,
        contactId: contact.id,
        time: source.time,
        createdAt: Date.now(),
      });
    }
    saved(`本批 ${result.memories.length} 条事件记忆，用户修订的画像优先保留`);
    this.changed();
  }
  async stop(): Promise<void> {
    this.stopped = true;
    for (const id of this.work.keys()) this.cancel(id, '应用关闭，任务已取消');
    await Promise.allSettled(this.tasks);
  }
}
