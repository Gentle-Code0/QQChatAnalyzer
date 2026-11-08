import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { AnalysisEngine } from '../server/engine.js';
import { AiCallError, prompts, type AiClient } from '../server/ai.js';
import type { ProgressReporter } from '../server/progress.js';
import { analysisRunSchema, contactSchema, conversationSchema } from '../shared/schema.js';
import { fixture, deferred } from './helpers.js';

const summary = {
  summary: '测试摘要',
  relevant: true,
  significant: false,
  attitude: 0,
  emotion: 0,
  mood: '平静',
  reason: '没有明显变化',
};
class TraceAi implements AiClient {
  constructor(
    private readonly respond: (
      instruction: string,
      context: unknown,
      signal: AbortSignal,
      report?: ProgressReporter,
    ) => unknown | Promise<unknown>,
  ) {}
  async call<T>(
    instruction: string,
    context: unknown,
    schema: z.ZodType<T>,
    signal: AbortSignal,
    report?: ProgressReporter,
  ): Promise<T> {
    return schema.parse(await this.respond(instruction, context, signal, report));
  }
}
function respond(instruction: string) {
  if (instruction === prompts.summary) return summary;
  if (instruction === prompts.gate) return { needed: true, reason: '需要跟进', keywords: [] };
  if (instruction === prompts.advice) return { analysis: '测试依据', advice: '确认安排' };
  return {
    traits: { likes: '', boundaries: '', communication: '' },
    traitSourceIds: { likes: [], boundaries: [], communication: [] },
    memories: [],
  };
}

test(
  '完整任务时间线显示检索、建议、证据和保存步骤，不包含聊天原文',
  { timeout: 5000 },
  async () => {
    const data = fixture();
    const done = deferred<void>();
    const engine = new AnalysisEngine(data.store, new TraceAi(respond), () => {
      if (engine.activity(data.conversation.id).at(-1)?.status === 'completed') done.resolve();
    });
    try {
      data.store.addMessage(data.message('1', 'invalid-private-test-message'));
      engine.flush(data.conversation.id);
      await done.promise;
      const run = analysisRunSchema.parse(engine.activity(data.conversation.id).at(-1));
      const labels = run.steps.map((step) => step.label);
      for (const label of [
        '摘要更新',
        '建议必要性判断',
        '检索历史记忆',
        '详细建议生成',
        '保存建议判断',
        '画像与记忆归纳',
        '校验对象身份与消息证据',
        '保存画像与事件记忆',
      ])
        assert.ok(labels.includes(label));
      assert.ok(labels.indexOf('检索历史记忆') < labels.indexOf('详细建议生成'));
      assert.ok(
        run.steps.every((step) => step.status === 'completed' && step.finishedAt !== undefined),
      );
      assert.equal(JSON.stringify(run).includes('invalid-private-test-message'), false);
    } finally {
      await engine.stop();
      data.cleanup();
    }
  },
);

test(
  '消息合并等待和未触发建议的原因可见，记录只保留最近 5 轮',
  { timeout: 5000 },
  async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const data = fixture();
    const done = deferred<void>();
    const engine = new AnalysisEngine(data.store, new TraceAi(respond), () => {
      if (engine.activity(data.conversation.id).at(-1)?.status === 'completed') done.resolve();
    });
    try {
      data.store.addMessage(data.message('1'));
      for (let i = 0; i < 7; i++) engine.notify(data.conversation.id);
      const waiting = engine.activity(data.conversation.id);
      assert.equal(waiting.length, 5);
      assert.equal(waiting.at(-1)?.status, 'waiting');
      assert.ok(waiting.slice(0, -1).every((run) => run.status === 'cancelled'));
      context.mock.timers.tick(data.store.settings.mergeWindowSeconds * 1000);
      await done.promise;
      const run = engine.activity(data.conversation.id).at(-1);
      assert.equal(run?.steps[0]?.label, '等待消息合并');
      assert.equal(run?.steps[0]?.status, 'completed');
      assert.ok(
        run?.steps.some((step) => step.status === 'skipped' && step.detail.includes('触发条件')),
      );
    } finally {
      await engine.stop();
      context.mock.timers.reset();
      data.cleanup();
    }
  },
);

test('失败会结束正在运行的 AI 与工具步骤，并保留安全诊断', { timeout: 5000 }, async () => {
  const data = fixture();
  const done = deferred<void>();
  const ai = new TraceAi((_instruction, _context, _signal, report) => {
    report?.({
      id: 'request',
      kind: 'ai',
      label: '调用模型 · 等待服务响应',
      status: 'running',
      detail: '',
    });
    throw new AiCallError('HTTP 响应', 'AI 服务返回 HTTP 429。');
  });
  const engine = new AnalysisEngine(data.store, ai, () => {
    if (engine.activity(data.conversation.id).at(-1)?.status === 'failed') done.resolve();
  });
  try {
    data.store.addMessage(data.message('1'));
    engine.flush(data.conversation.id);
    await done.promise;
    const run = engine.activity(data.conversation.id).at(-1);
    assert.match(run?.detail ?? '', /HTTP 429/);
    assert.ok(run?.steps.some((step) => step.label === '摘要更新' && step.status === 'failed'));
    assert.ok(run?.steps.some((step) => step.id === 'request' && step.status === 'failed'));
    assert.equal(
      run?.steps.some((step) => step.status === 'running'),
      false,
    );
    assert.equal(data.store.conversation(data.conversation.id)?.processedSequence, 0);
  } finally {
    await engine.stop();
    data.cleanup();
  }
});

test(
  '不同对象并行时取消一个会话，不修改另一对象或被取消任务的记录',
  { timeout: 5000 },
  async () => {
    const data = fixture();
    const other = contactSchema.parse({ ...data.contact, id: 'other', qq: '67890' });
    data.store.saveContact(other);
    data.store.saveConversation(
      conversationSchema.parse({
        id: 'other-conversation',
        contactId: other.id,
        kind: 'private',
        peerId: other.qq,
      }),
    );
    const started = { first: deferred<void>(), second: deferred<void>() };
    const responses = { first: deferred<unknown>(), second: deferred<unknown>() };
    const secondDone = deferred<void>();
    let lateReport: ProgressReporter | undefined;
    const ai = new TraceAi((instruction, payload, _signal, report) => {
      if (instruction !== prompts.summary) return respond(instruction);
      const id = z.object({ contact: z.object({ id: z.string() }) }).parse(payload).contact.id;
      if (id === data.contact.id) {
        lateReport = report;
        report?.({
          id: 'first-image',
          kind: 'tool',
          label: 'get_image · 读取图片地址',
          status: 'running',
          detail: '',
        });
        started.first.resolve();
        return responses.first.promise;
      }
      started.second.resolve();
      return responses.second.promise;
    });
    const engine = new AnalysisEngine(data.store, ai, () => {
      if (engine.activity('other-conversation').at(-1)?.status === 'completed')
        secondDone.resolve();
    });
    try {
      data.store.addMessage(data.message('1'));
      data.store.addMessage({
        ...data.message('2'),
        conversationId: 'other-conversation',
        senderId: other.qq,
      });
      engine.flush(data.conversation.id);
      engine.flush('other-conversation');
      await Promise.all([started.first.promise, started.second.promise]);
      data.store.saveConversation({
        ...data.store.conversation(data.conversation.id)!,
        paused: true,
      });
      engine.cancel(data.conversation.id, '会话已暂停');
      const cancelled = engine.activity(data.conversation.id);
      assert.equal(cancelled.at(-1)?.status, 'cancelled');
      assert.equal(engine.activity('other-conversation').at(-1)?.status, 'running');
      lateReport?.({
        id: 'first-image',
        kind: 'tool',
        label: 'get_image · 读取图片地址',
        status: 'completed',
        detail: '不应写入',
      });
      responses.first.resolve(summary);
      responses.second.resolve(summary);
      await secondDone.promise;
      await engine.stop();
      assert.deepEqual(engine.activity(data.conversation.id), cancelled);
      assert.equal(data.store.conversation(data.conversation.id)?.processedSequence, 0);
      assert.ok((data.store.conversation('other-conversation')?.processedSequence ?? 0) > 0);
    } finally {
      responses.first.resolve(summary);
      responses.second.resolve(summary);
      await engine.stop();
      data.cleanup();
    }
  },
);

test(
  '新消息将旧任务标记为取消，晚到的工具结果不能修改新任务',
  { timeout: 5000 },
  async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const data = fixture();
    const started = deferred<void>();
    const response = deferred<unknown>();
    const done = deferred<void>();
    let first = true;
    let lateReport: ProgressReporter | undefined;
    const ai = new TraceAi((instruction, _payload, _signal, report) => {
      if (first) {
        first = false;
        lateReport = report;
        started.resolve();
        return response.promise;
      }
      return respond(instruction);
    });
    const engine = new AnalysisEngine(data.store, ai, () => {
      if (engine.activity(data.conversation.id).at(-1)?.status === 'completed') done.resolve();
    });
    try {
      data.store.addMessage(data.message('1'));
      engine.flush(data.conversation.id);
      await started.promise;
      data.store.addMessage(data.message('2'));
      engine.notify(data.conversation.id);
      const old = engine.activity(data.conversation.id)[0];
      assert.equal(old?.status, 'cancelled');
      assert.match(old?.detail ?? '', /新消息/);
      assert.equal(engine.activity(data.conversation.id).at(-1)?.status, 'waiting');
      lateReport?.({
        id: 'late',
        kind: 'tool',
        label: '晚到的结果',
        status: 'completed',
        detail: '不应写入',
      });
      response.resolve(summary);
      context.mock.timers.tick(data.store.settings.mergeWindowSeconds * 1000);
      await done.promise;
      assert.deepEqual(engine.activity(data.conversation.id)[0], old);
      assert.equal(
        JSON.stringify(engine.activity(data.conversation.id)).includes('不应写入'),
        false,
      );
    } finally {
      response.resolve(summary);
      await engine.stop();
      context.mock.timers.reset();
      data.cleanup();
    }
  },
);
