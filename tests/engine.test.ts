import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { AnalysisEngine } from '../server/engine.js';
import { prompts, type AiClient } from '../server/ai.js';
import { fixture, deferred } from './helpers.js';

const light = {
  summary: '讨论周六见面；时间尚未回答。',
  relevant: true,
  significant: false,
  attitude: 15,
  emotion: 10,
  mood: '平静',
  reason: '对方主动讨论约定',
};
const consolidation = {
  traits: { likes: '', boundaries: '', communication: '表达直接' },
  memories: [],
};
class FakeAi implements AiClient {
  readonly calls: string[] = [];
  constructor(
    private readonly respond: (
      instruction: string,
      signal: AbortSignal,
      context: unknown,
    ) => unknown | Promise<unknown>,
  ) {}
  async call<T>(
    _tier: 'light' | 'full',
    instruction: string,
    context: unknown,
    schema: z.ZodType<T>,
    signal: AbortSignal,
  ): Promise<T> {
    this.calls.push(instruction);
    return schema.parse(await this.respond(instruction, signal, context));
  }
}
function watcher(predicate: () => boolean) {
  const ready = deferred<void>();
  return {
    changed: () => {
      if (predicate()) ready.resolve();
    },
    promise: ready.promise,
  };
}

for (const mergeWindowSeconds of [3, 7]) {
  test(
    `合并窗口为 ${mergeWindowSeconds} 秒时，后续消息重新计时并统一轻量分析`,
    { timeout: 5000 },
    async (context) => {
      context.mock.timers.enable({ apis: ['setTimeout'] });
      const data = fixture();
      data.store.settings = { ...data.store.settings, mergeWindowSeconds };
      const summarized = watcher(
        () => data.store.conversation(data.conversation.id)!.processedSequence > 0,
      );
      let messageCount = 0;
      const ai = new FakeAi((_instruction, _signal, payload) => {
        messageCount = z.object({ messages: z.array(z.unknown()) }).parse(payload).messages.length;
        return light;
      });
      const engine = new AnalysisEngine(data.store, ai, summarized.changed);
      try {
        data.store.addMessage(data.message('1'));
        engine.notify(data.conversation.id);
        context.mock.timers.tick(1000);
        data.store.addMessage(data.message('2'));
        engine.notify(data.conversation.id);
        context.mock.timers.tick(mergeWindowSeconds * 1000 - 1);
        assert.equal(ai.calls.length, 0);
        context.mock.timers.tick(1);
        await summarized.promise;
        assert.deepEqual(ai.calls, [prompts.light]);
        assert.equal(messageCount, 2);
      } finally {
        await engine.stop();
        context.mock.timers.reset();
        data.cleanup();
      }
    },
  );
}

test('自定义累计阈值达到 3 条时触发轻量建议判断', { timeout: 5000 }, async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const data = fixture();
  data.store.settings = { ...data.store.settings, messageThreshold: 3 };
  const summarized = watcher(
    () => data.store.conversation(data.conversation.id)!.processedSequence > 0,
  );
  const completed = watcher(() => data.store.contact(data.contact.id)!.traitsRevision > 0);
  const ai = new FakeAi((instruction) =>
    instruction === prompts.light
      ? light
      : instruction === prompts.gate
        ? { needed: false, reason: '无需建议', keywords: [] }
        : consolidation,
  );
  const engine = new AnalysisEngine(data.store, ai, () => {
    summarized.changed();
    completed.changed();
  });
  try {
    data.store.addMessage(data.message('1'));
    data.store.addMessage(data.message('2'));
    engine.notify(data.conversation.id);
    context.mock.timers.tick(3000);
    await summarized.promise;
    assert.equal(data.store.decisions(data.conversation.id).length, 0);
    data.store.addMessage(data.message('3'));
    engine.notify(data.conversation.id);
    context.mock.timers.tick(3000);
    await completed.promise;
    assert.equal(data.store.decisions(data.conversation.id)[0]?.trigger, '消息数量阈值');
  } finally {
    await engine.stop();
    context.mock.timers.reset();
    data.cleanup();
  }
});

test('需要建议时先通过轻量判断，再检索历史并保存完整建议及来源', { timeout: 5000 }, async () => {
  const data = fixture();
  const watched = watcher(() => data.store.contact(data.contact.id)!.traitsRevision > 0);
  let retrievedIds: string[] = [];
  data.store.saveMemory({
    id: 'appointment',
    contactId: data.contact.id,
    kind: 'promise',
    text: '之前约定周六见面',
    time: Date.now(),
    createdAt: Date.now(),
    sourceIds: ['old'],
    keywords: ['见面'],
  });
  const ai = new FakeAi((instruction, _signal, context) => {
    if (instruction === prompts.light) return light;
    if (instruction === prompts.gate)
      return { needed: true, reason: '有待确认的约定', keywords: ['见面'] };
    if (instruction === prompts.advice) {
      retrievedIds = z
        .object({ memories: z.array(z.object({ id: z.string() })) })
        .parse(context)
        .memories.map((memory) => memory.id);
      return { analysis: '对方在确认之前的约定', advice: '先确认你自己的时间，再把安排沟通清楚。' };
    }
    return consolidation;
  });
  const engine = new AnalysisEngine(data.store, ai, watched.changed);
  try {
    data.store.addMessage(data.message('1'));
    engine.flush(data.conversation.id);
    await watched.promise;
    const decision = data.store.decisions(data.conversation.id)[0];
    assert.equal(decision?.needed, true);
    assert.match(decision?.advice ?? '', /确认/);
    assert.deepEqual(retrievedIds, ['appointment']);
    assert.deepEqual(decision?.memoryIds, ['appointment']);
    assert.ok(ai.calls.indexOf(prompts.gate) < ai.calls.indexOf(prompts.advice));
  } finally {
    await engine.stop();
    data.cleanup();
  }
});

test('历史归纳保留可核验来源，拒绝模型编造的来源，并不生成建议', { timeout: 5000 }, async () => {
  const data = fixture();
  const watched = watcher(
    () => data.store.conversation(data.conversation.id)!.processedSequence > 0,
  );
  const message = { ...data.message('history-1'), source: 'history' as const };
  const memory = {
    kind: 'promise',
    text: '周六见面',
    time: 0,
    sourceIds: ['history-1'],
    keywords: ['见面'],
  };
  const ai = new FakeAi((instruction) =>
    instruction === prompts.light
      ? light
      : { ...consolidation, memories: [memory, { ...memory, sourceIds: ['invented'] }] },
  );
  const engine = new AnalysisEngine(data.store, ai, watched.changed);
  try {
    data.store.addMessage(message);
    engine.flush(data.conversation.id);
    await watched.promise;
    assert.equal(data.store.memories(data.contact.id).length, 1);
    assert.equal(data.store.memories(data.contact.id)[0]?.time, message.time);
    assert.equal(data.store.decisions(data.conversation.id).length, 0);
    assert.equal(ai.calls.includes(prompts.gate), false);
  } finally {
    await engine.stop();
    data.cleanup();
  }
});

test('归纳失败后可单独重试，不因判断进度已推进而丢失记忆', { timeout: 5000 }, async () => {
  const data = fixture();
  const failed = watcher(
    () => data.store.conversation(data.conversation.id)!.status === '分析失败',
  );
  const completed = watcher(() => data.store.contact(data.contact.id)!.traitsRevision > 0);
  let attempts = 0;
  const ai = new FakeAi((instruction) => {
    if (instruction === prompts.light) return light;
    if (instruction === prompts.gate) return { needed: false, reason: '无需建议', keywords: [] };
    attempts++;
    if (attempts === 1) throw new Error('测试中的临时网络错误');
    return consolidation;
  });
  const engine = new AnalysisEngine(data.store, ai, () => {
    failed.changed();
    completed.changed();
  });
  try {
    data.store.addMessage(data.message('1'));
    engine.flush(data.conversation.id);
    await failed.promise;
    assert.equal(data.store.conversation(data.conversation.id)!.consolidatedSequence, 0);
    assert.ok(data.store.conversation(data.conversation.id)!.lastDecisionSequence > 0);
    engine.flush(data.conversation.id);
    await completed.promise;
    assert.equal(attempts, 2);
    assert.equal(data.store.decisions(data.conversation.id).length, 1);
  } finally {
    await engine.stop();
    data.cleanup();
  }
});

test(
  '双方静默达到阈值才触发建议判断，单条普通消息只更新摘要',
  { timeout: 5000 },
  async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const data = fixture();
    const summarized = watcher(
      () => data.store.conversation(data.conversation.id)!.processedSequence > 0,
    );
    const completed = watcher(() => data.store.contact(data.contact.id)!.traitsRevision > 0);
    const ai = new FakeAi((instruction) =>
      instruction === prompts.light
        ? light
        : instruction === prompts.gate
          ? { needed: false, reason: '无需建议', keywords: [] }
          : consolidation,
    );
    const engine = new AnalysisEngine(data.store, ai, () => {
      summarized.changed();
      completed.changed();
    });
    try {
      data.store.addMessage(data.message('1'));
      engine.notify(data.conversation.id);
      context.mock.timers.tick(data.store.settings.mergeWindowSeconds * 1000);
      await summarized.promise;
      assert.equal(data.store.decisions(data.conversation.id).length, 0);
      context.mock.timers.tick(data.store.settings.idleSeconds * 1000);
      await completed.promise;
      assert.equal(data.store.decisions(data.conversation.id)[0]?.trigger, '对话静默');
    } finally {
      await engine.stop();
      context.mock.timers.reset();
      data.cleanup();
    }
  },
);

test('会话暂停会中断在途请求，返回后不写入分析结果', { timeout: 5000 }, async () => {
  const data = fixture();
  const started = deferred<AbortSignal>();
  const response = deferred<unknown>();
  const ai = new FakeAi((_instruction, signal) => {
    started.resolve(signal);
    return response.promise;
  });
  const engine = new AnalysisEngine(data.store, ai, () => {});
  try {
    data.store.addMessage(data.message('1'));
    engine.flush(data.conversation.id);
    const signal = await started.promise;
    data.store.saveConversation({
      ...data.store.conversation(data.conversation.id)!,
      paused: true,
    });
    engine.cancel(data.conversation.id);
    assert.equal(signal.aborted, true);
    response.resolve(light);
    await engine.stop();
    assert.equal(data.store.observations(data.conversation.id).length, 0);
    assert.equal(data.store.conversation(data.conversation.id)!.processedSequence, 0);
  } finally {
    response.resolve(light);
    await engine.stop();
    data.cleanup();
  }
});

test('无需建议时保存原因，不调用复杂建议；仍允许更新长期画像', { timeout: 5000 }, async () => {
  const data = fixture();
  const watched = watcher(() => data.store.contact(data.contact.id)!.traitsRevision > 0);
  const ai = new FakeAi((instruction) =>
    instruction === prompts.light
      ? light
      : instruction === prompts.gate
        ? { needed: false, reason: '普通讨论，无需介入', keywords: [] }
        : consolidation,
  );
  const engine = new AnalysisEngine(data.store, ai, watched.changed);
  try {
    data.store.addMessage(data.message('1'));
    engine.flush(data.conversation.id);
    await watched.promise;
    assert.equal(data.store.decisions(data.conversation.id)[0]?.needed, false);
    assert.match(data.store.decisions(data.conversation.id)[0]?.reason ?? '', /无需介入/);
    assert.equal(ai.calls.includes(prompts.advice), false);
  } finally {
    await engine.stop();
    data.cleanup();
  }
});

test('新消息中断旧请求，忽略即使供应商取消失败后仍返回的旧结果', { timeout: 5000 }, async () => {
  const data = fixture();
  const started = deferred<AbortSignal>();
  const stale = deferred<unknown>();
  let lightCalls = 0;
  const watched = watcher(() => data.store.contact(data.contact.id)!.traitsRevision > 0);
  const ai = new FakeAi((instruction, signal) => {
    if (instruction === prompts.light) {
      lightCalls++;
      if (lightCalls === 1) {
        started.resolve(signal);
        return stale.promise;
      }
      return light;
    }
    return instruction === prompts.gate
      ? { needed: false, reason: '无需建议', keywords: [] }
      : consolidation;
  });
  const engine = new AnalysisEngine(data.store, ai, watched.changed);
  try {
    data.store.addMessage(data.message('1'));
    engine.flush(data.conversation.id);
    const signal = await started.promise;
    data.store.addMessage(data.message('2'));
    engine.flush(data.conversation.id);
    assert.equal(signal.aborted, true);
    await watched.promise;
    stale.resolve({ ...light, summary: '过期摘要' });
    await engine.stop();
    assert.equal(data.store.conversation(data.conversation.id)?.summary, light.summary);
    assert.equal(data.store.observations(data.conversation.id).length, 1);
  } finally {
    stale.resolve(light);
    await engine.stop();
    data.cleanup();
  }
});

test('对象暂停时完全禁止 AI 调用', async () => {
  const data = fixture();
  const ai = new FakeAi(() => {
    throw new Error('不应调用');
  });
  const engine = new AnalysisEngine(data.store, ai, () => {});
  try {
    data.store.saveContact({ ...data.contact, paused: true });
    data.store.addMessage(data.message('1'));
    engine.flush(data.conversation.id);
    engine.notify(data.conversation.id);
    await engine.stop();
    assert.equal(ai.calls.length, 0);
  } finally {
    await engine.stop();
    data.cleanup();
  }
});

test('采用建议后的冷却保留摘要更新，跳过重复建议判断', { timeout: 5000 }, async () => {
  const data = fixture();
  const watched = watcher(() => data.store.contact(data.contact.id)!.traitsRevision > 0);
  const ai = new FakeAi((instruction) => (instruction === prompts.light ? light : consolidation));
  const engine = new AnalysisEngine(data.store, ai, watched.changed);
  try {
    data.store.saveConversation({ ...data.conversation, adoptedUntil: Date.now() + 60000 });
    data.store.addMessage(data.message('1'));
    engine.flush(data.conversation.id);
    await watched.promise;
    assert.match(data.store.decisions(data.conversation.id)[0]?.reason ?? '', /冷却/);
    assert.equal(data.store.conversation(data.conversation.id)?.summary, light.summary);
    assert.equal(ai.calls.includes(prompts.gate), false);
  } finally {
    await engine.stop();
    data.cleanup();
  }
});

test('群聊无关内容不进入摘要与历史记忆，也不调用完整模型', { timeout: 5000 }, async () => {
  const data = fixture();
  const watched = watcher(() => data.store.decisions(data.conversation.id).length > 0);
  const ai = new FakeAi(() => ({ ...light, relevant: false }));
  const engine = new AnalysisEngine(data.store, ai, watched.changed);
  try {
    data.store.saveConversation({ ...data.conversation, kind: 'group', summary: '原摘要' });
    data.store.addMessage(data.message('1', '无关闲聊'));
    engine.flush(data.conversation.id);
    await watched.promise;
    assert.equal(data.store.conversation(data.conversation.id)?.summary, '原摘要');
    assert.equal(data.store.memories(data.contact.id).length, 0);
    assert.deepEqual(ai.calls, [prompts.light]);
  } finally {
    await engine.stop();
    data.cleanup();
  }
});
