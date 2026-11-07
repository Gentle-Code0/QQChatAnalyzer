import { randomUUID, createHash } from 'node:crypto';
import { Store } from './store.js';
import {
  prompts,
  lightResultSchema,
  gateResultSchema,
  adviceResultSchema,
  consolidationSchema,
  type AiClient,
} from './ai.js';
import type { Contact, Conversation, Message, Memory } from '../shared/schema.js';

interface ConversationWork {
  controller?: AbortController;
  debounce?: ReturnType<typeof setTimeout>;
  idle?: ReturnType<typeof setTimeout>;
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

/** Owns debounce/idle timers and every AI task. Abort + identity guards reject stale responses. */
export class AnalysisEngine {
  private readonly work = new Map<string, ConversationWork>();
  private readonly tasks = new Set<Promise<void>>();
  private stopped = false;
  constructor(
    private readonly store: Store,
    private readonly ai: AiClient,
    private readonly changed: () => void,
  ) {}

  private active(id: string): { conversation: Conversation; contact: Contact } | undefined {
    if (this.stopped) return;
    const conversation = this.store.conversation(id);
    const contact = conversation ? this.store.contact(conversation.contactId) : undefined;
    if (!conversation || !contact || contact.paused || conversation.paused) return;
    return { conversation, contact };
  }
  notify(id: string, live = true): void {
    this.cancel(id);
    if (!this.active(id)) return;
    const work: ConversationWork = {};
    this.work.set(id, work);
    work.debounce = setTimeout(() => this.launch(id, live ? '消息更新' : '历史归纳'), 250);
    if (live)
      work.idle = setTimeout(
        () => this.launch(id, '对话静默'),
        this.store.settings.idleSeconds * 1000,
      );
  }
  flush(id: string): void {
    this.cancel(id);
    if (this.active(id)) this.launch(id, '手动检查');
  }
  cancel(id: string): void {
    const work = this.work.get(id);
    work?.controller?.abort();
    clearTimeout(work?.debounce);
    clearTimeout(work?.idle);
    this.work.delete(id);
  }
  private launch(id: string, trigger: string): void {
    const work = this.work.get(id) ?? {};
    work.controller?.abort();
    clearTimeout(work.debounce);
    const controller = new AbortController();
    work.controller = controller;
    this.work.set(id, work);
    const task = this.run(id, trigger, controller)
      .catch(() => {
        if (controller.signal.aborted || !this.active(id)) return;
        const conversation = this.store.conversation(id)!;
        this.store.saveConversation({
          ...conversation,
          status: '分析失败',
          error: 'AI 请求失败或返回格式无效。请检查 API 设置后点击重新检查。',
        });
        this.changed();
      })
      .finally(() => {
        this.tasks.delete(task);
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
  private async run(
    id: string,
    initialTrigger: string,
    controller: AbortController,
  ): Promise<void> {
    let trigger = initialTrigger;
    let significant = false;
    let relevant = this.store.observations(id).at(-1)?.relevant ?? false;
    while (this.valid(id, controller)) {
      const current = this.active(id)!;
      const pending = this.store.pendingMessages(id, current.conversation.processedSequence);
      if (pending.length === 0) break;
      this.store.saveConversation({ ...current.conversation, status: '轻量分析中', error: '' });
      this.changed();
      const historical = pending.every((message) => message.source === 'history');
      const context = {
        self: this.store.self,
        contact: current.contact,
        kind: current.conversation.kind,
        previousSummary: current.conversation.summary,
        recentContext: this.store
          .messages(id, 0, 10)
          .filter((message) => message.sequence <= current.conversation.processedSequence),
        messages: pending,
        previousSignals: this.store.observations(id).slice(-5),
      };
      const result = await this.ai.call(
        'light',
        prompts.light,
        context,
        lightResultSchema,
        controller.signal,
      );
      if (!this.valid(id, controller)) return;
      relevant = current.conversation.kind === 'private' || result.relevant;
      significant ||= result.significant && relevant;
      this.store.saveObservation({
        id: randomUUID(),
        conversationId: id,
        time: Date.now(),
        ...result,
        relevant,
        sourceIds: pending.map((message) => message.id),
      });
      // Historical extraction is checkpointed only after the full batch has been consolidated.
      if (historical && relevant) await this.consolidate(id, pending, controller);
      if (!this.valid(id, controller)) return;
      const latest = this.store.conversation(id)!;
      this.store.saveConversation({
        ...latest,
        summary: relevant ? result.summary : latest.summary,
        processedSequence: pending.at(-1)!.sequence,
        consolidatedSequence:
          historical && relevant ? pending.at(-1)!.sequence : latest.consolidatedSequence,
        status: '观察中',
        error: '',
      });
      this.changed();
      if (historical) trigger = '历史归纳';
    }
    if (!this.valid(id, controller)) return;
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
    if (!due || trigger === '历史归纳') return;
    if (recent.length === 0) {
      await this.consolidatePending(id, controller);
      return;
    }
    if (threshold) trigger = '消息数量阈值';
    if (significant) trigger = '明显态度/情绪变化';
    if (!relevant) {
      this.recordDecision(
        id,
        false,
        '当前群聊未发现与用户有关的内容，不提供建议。',
        '',
        trigger,
        [],
      );
      this.store.saveConversation({
        ...this.store.conversation(id)!,
        consolidatedSequence: conversation.processedSequence,
      });
      return;
    }
    if (conversation.adoptedUntil > Date.now()) {
      this.recordDecision(id, false, '已采用上一条建议，冷却期间暂不重复提醒。', '', trigger, []);
    } else {
      const context = {
        self: this.store.self,
        contact,
        summary: conversation.summary,
        messages: recent,
        signals: this.store.observations(id).slice(-20),
      };
      const gate = await this.ai.call(
        'light',
        prompts.gate,
        context,
        gateResultSchema,
        controller.signal,
      );
      if (!this.valid(id, controller)) return;
      if (!gate.needed) this.recordDecision(id, false, gate.reason, '', trigger, []);
      else {
        const memories = retrieveMemories(
          this.store.memories(contact.id),
          gate.keywords,
          Date.now(),
        );
        const result = await this.ai.call(
          'full',
          prompts.advice,
          { ...context, memories, gate },
          adviceResultSchema,
          controller.signal,
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
    if (trigger === '对话静默' || threshold || significant || trigger === '手动检查') {
      await this.consolidatePending(id, controller);
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
    this.store.saveDecision({
      id: randomUUID(),
      conversationId: id,
      time: Date.now(),
      needed,
      reason,
      advice,
      trigger,
      memoryIds,
      adopted: false,
    });
    this.store.saveConversation({
      ...conversation,
      lastDecisionSequence: conversation.processedSequence,
      status: '观察中',
      error: '',
    });
    this.changed();
  }
  private async consolidate(
    id: string,
    messages: Message[],
    controller: AbortController,
  ): Promise<void> {
    const { contact, conversation } = this.active(id)!;
    const result = await this.ai.call(
      'full',
      prompts.consolidate,
      {
        self: this.store.self,
        traits: contact.traits,
        summary: conversation.summary,
        messages,
        existingMemories: this.store.memories(contact.id).slice(-60),
      },
      consolidationSchema,
      controller.signal,
    );
    if (!this.valid(id, controller)) return;
    const latestContact = this.store.contact(contact.id)!;
    // User edits made during a request take precedence over its inferred trait snapshot.
    if (latestContact.traitsRevision === contact.traitsRevision) {
      this.store.saveContact({
        ...latestContact,
        traits: result.traits,
        traitsRevision: latestContact.traitsRevision + 1,
      });
    }
    const available = new Map(messages.map((message) => [message.id, message]));
    for (const memory of result.memories) {
      if (!memory.sourceIds.every((sourceId) => available.has(sourceId))) continue;
      const source = available.get(memory.sourceIds[0]!);
      if (!source) continue;
      const fingerprint = createHash('sha256')
        .update(`${contact.id}:${memory.kind}:${memory.sourceIds.slice().sort().join(',')}`)
        .digest('hex');
      this.store.saveMemory({
        ...memory,
        id: fingerprint,
        contactId: contact.id,
        time: source.time,
        createdAt: Date.now(),
      });
    }
    this.changed();
  }
  async stop(): Promise<void> {
    this.stopped = true;
    for (const id of this.work.keys()) this.cancel(id);
    await Promise.allSettled(this.tasks);
  }
}
