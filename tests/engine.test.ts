import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { AnalysisEngine } from '../server/engine.js';
import { AiCallError, prompts, type AiClient } from '../server/ai.js';
import { fixture, deferred } from './helpers.js';
import { buildContextContent } from '../server/ai-context.js';

const light = {
  adviceSignal: { worthChecking: false, reason: '普通讨论，暂不值得进一步判断' },
  compressedPreviousSummary: '',
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
  traitSourceIds: { likes: [], boundaries: [], communication: ['1'] },
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

for (const mergeWindowSeconds of [5, 7]) {
  test(
    `合并窗口为 ${mergeWindowSeconds} 秒时，后续消息重新计时并统一摘要分析`,
    { timeout: 5000 },
    async (context) => {
      context.mock.timers.enable({ apis: ['setTimeout'] });
      const data = fixture();
      data.store.settings = {
        ...data.store.settings,
        mergeWindowSeconds,
        summaryIdleSeconds: mergeWindowSeconds,
      };
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
        assert.deepEqual(ai.calls, [prompts.summary]);
        assert.equal(messageCount, 2);
      } finally {
        await engine.stop();
        context.mock.timers.reset();
        data.cleanup();
      }
    },
  );
}

test('自定义累计阈值达到 3 条时触发建议必要性判断', { timeout: 5000 }, async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const data = fixture();
  data.store.settings = {
    ...data.store.settings,
    messageThreshold: 3,
    summaryMessageThreshold: 2,
    consolidationMessageThreshold: 3,
  };
  const summarized = watcher(
    () => data.store.conversation(data.conversation.id)!.processedSequence > 0,
  );
  const completed = watcher(() => data.store.contact(data.contact.id)!.traitsRevision > 0);
  const ai = new FakeAi((instruction) =>
    instruction === prompts.summary
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
    assert.equal(data.store.decisions(data.conversation.id).length, 1);
    assert.equal(data.store.decisions(data.conversation.id)[0]?.trigger, '摘要建议预筛');
    assert.equal(data.store.conversation(data.conversation.id)!.lastDecisionSequence, 0);
    assert.equal(ai.calls.includes(prompts.gate), false);
    data.store.addMessage(data.message('3'));
    engine.notify(data.conversation.id);
    context.mock.timers.tick(3000);
    await completed.promise;
    assert.equal(data.store.decisions(data.conversation.id).at(-1)?.trigger, '消息数量阈值');
  } finally {
    await engine.stop();
    context.mock.timers.reset();
    data.cleanup();
  }
});

test('需要建议时先通过必要性判断，再检索历史并保存完整建议及来源', { timeout: 5000 }, async () => {
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
    if (instruction === prompts.summary) return light;
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

test('历史归纳保留可核验来源，并不生成建议', { timeout: 5000 }, async () => {
  const data = fixture();
  const watched = watcher(
    () => data.store.conversation(data.conversation.id)!.consolidatedSequence > 0,
  );
  const message = { ...data.message('history-1'), source: 'history' as const };
  const memory = {
    subjectId: data.contact.qq,
    kind: 'promise',
    text: '周六见面',
    time: 0,
    sourceIds: ['history-1'],
    keywords: ['见面'],
  };
  const ai = new FakeAi((instruction) =>
    instruction === prompts.summary
      ? light
      : {
          ...consolidation,
          traitSourceIds: { likes: [], boundaries: [], communication: ['history-1'] },
          memories: [memory],
        },
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
    if (instruction === prompts.summary) return light;
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
    const completed = watcher(() =>
      data.store
        .decisions(data.conversation.id)
        .some((decision) => decision.trigger === '对话静默'),
    );
    const ai = new FakeAi((instruction) =>
      instruction === prompts.summary
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
      assert.equal(data.store.decisions(data.conversation.id).length, 1);
      assert.equal(data.store.decisions(data.conversation.id)[0]?.trigger, '摘要建议预筛');
      assert.equal(data.store.conversation(data.conversation.id)!.lastDecisionSequence, 0);
      assert.equal(ai.calls.includes(prompts.gate), false);
      context.mock.timers.tick(data.store.settings.idleSeconds * 1000);
      await completed.promise;
      assert.equal(data.store.decisions(data.conversation.id).at(-1)?.trigger, '对话静默');
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

test('无需建议时保存原因，不生成详细建议；仍允许更新长期画像', { timeout: 5000 }, async () => {
  const data = fixture();
  const watched = watcher(() => data.store.contact(data.contact.id)!.traitsRevision > 0);
  const ai = new FakeAi((instruction) =>
    instruction === prompts.summary
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
    if (instruction === prompts.summary) {
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

test('旧数据的采纳冷却不再阻止建议判断', { timeout: 5000 }, async () => {
  const data = fixture();
  const watched = watcher(() => data.store.contact(data.contact.id)!.traitsRevision > 0);
  const ai = new FakeAi((instruction) =>
    instruction === prompts.summary
      ? light
      : instruction === prompts.gate
        ? { needed: false, reason: '普通聊天', keywords: [] }
        : consolidation,
  );
  const engine = new AnalysisEngine(data.store, ai, watched.changed);
  try {
    data.store.saveConversation({ ...data.conversation, ...{ adoptedUntil: Date.now() + 60000 } });
    data.store.addMessage(data.message('1'));
    engine.flush(data.conversation.id);
    await watched.promise;
    assert.equal(data.store.decisions(data.conversation.id)[0]?.reason, '普通聊天');
    assert.equal(ai.calls.includes(prompts.gate), true);
    assert.equal('adoptedUntil' in data.store.conversation(data.conversation.id)!, false);
    assert.equal('adopted' in data.store.decisions(data.conversation.id)[0]!, false);
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
    assert.deepEqual(ai.calls, [prompts.summary]);
  } finally {
    await engine.stop();
    data.cleanup();
  }
});

for (const kind of ['private', 'group'] as const) {
  for (const invalid of [
    'habit-self',
    'event-self',
    'event-other',
    'subject',
    'invented',
  ] as const) {
    test(
      `${kind} 归纳拒绝错误归属 ${invalid}，保留检查点并允许重试`,
      { timeout: 5000 },
      async () => {
        const data = fixture();
        data.store.settings = { ...data.store.settings, selfQq: '67890' };
        data.store.self = { ...data.store.self, name: '相同昵称' };
        data.store.saveConversation({ ...data.conversation, kind });
        const failed = watcher(
          () => data.store.conversation(data.conversation.id)?.status === '分析失败',
        );
        const completed = watcher(
          () => data.store.conversation(data.conversation.id)!.consolidatedSequence > 0,
        );
        let retry = false;
        const ai = new FakeAi((instruction, _signal, payload) => {
          if (instruction === prompts.summary) return light;
          if (instruction === prompts.gate)
            return { needed: false, reason: '无需建议', keywords: [] };
          const context = z
            .object({
              contact: z.object({ qq: z.string() }),
              kind: z.string(),
              participants: z.object({ self: z.object({ qq: z.string() }) }),
              messages: z.array(z.object({ id: z.string(), senderRole: z.string() })),
            })
            .parse(payload);
          assert.equal(context.contact.qq, data.contact.qq);
          assert.equal(context.participants.self.qq, '67890');
          assert.equal(context.kind, kind);
          assert.deepEqual(
            context.messages.map((m) => m.senderRole),
            ['self', 'other', 'contact'],
          );
          const sourceId =
            invalid === 'event-other' ? 'other' : invalid === 'invented' ? 'missing' : 'self';
          return {
            traits: { ...data.contact.traits, communication: '表达直接' },
            traitSourceIds: {
              likes: [],
              boundaries: [],
              communication: [!retry && invalid === 'habit-self' ? 'self' : 'target'],
            },
            memories: [
              {
                subjectId: !retry && invalid === 'subject' ? '67890' : data.contact.qq,
                kind: 'promise',
                text: '对象确认周六见面',
                time: 0,
                sourceIds: [
                  retry || invalid === 'habit-self' || invalid === 'subject' ? 'target' : sourceId,
                ],
                keywords: ['见面'],
              },
            ],
          };
        });
        const engine = new AnalysisEngine(data.store, ai, () => {
          failed.changed();
          completed.changed();
        });
        try {
          for (const [id, senderId] of [
            ['self', '67890'],
            ['other', '99999'],
            ['target', data.contact.qq],
          ] as const) {
            data.store.addMessage({
              ...data.message(id),
              senderId,
              senderName: '相同昵称',
              source: 'history',
            });
          }
          engine.flush(data.conversation.id);
          await failed.promise;
          const error = data.store.conversation(data.conversation.id)?.error ?? '';
          assert.match(error, /画像与记忆归纳失败/);
          assert.ok(
            error.includes(
              invalid === 'habit-self'
                ? '画像证据校验'
                : invalid === 'subject'
                  ? '记忆主体校验'
                  : '记忆证据校验',
            ),
          );
          assert.equal(data.store.contact(data.contact.id)?.traitsRevision, 0);
          assert.equal(data.store.memories(data.contact.id).length, 0);
          assert.equal(data.store.conversation(data.conversation.id)?.consolidatedSequence, 0);
          assert.ok(data.store.conversation(data.conversation.id)!.processedSequence > 0);
          retry = true;
          engine.flush(data.conversation.id);
          await completed.promise;
          assert.equal(data.store.contact(data.contact.id)?.traits.communication, '表达直接');
          assert.equal(data.store.memories(data.contact.id).length, 1);
          assert.deepEqual(data.store.memories(data.contact.id)[0]?.sourceIds, ['target']);
        } finally {
          await engine.stop();
          data.cleanup();
        }
      },
    );
  }
}

for (const action of ['edit', 'pause', 'new-message'] as const) {
  test(`归纳请求期间 ${action} 保护画像和检查点`, { timeout: 5000 }, async () => {
    const data = fixture();
    const started = deferred<AbortSignal>();
    const response = deferred<unknown>();
    const completed = watcher(
      () => data.store.contact(data.contact.id)?.traits.communication === '用户修订',
    );
    const ai = new FakeAi((instruction, signal) => {
      if (instruction === prompts.summary) return light;
      if (instruction === prompts.gate) return { needed: false, reason: '无需建议', keywords: [] };
      started.resolve(signal);
      return response.promise;
    });
    const engine = new AnalysisEngine(data.store, ai, completed.changed);
    try {
      data.store.addMessage(data.message('1'));
      engine.flush(data.conversation.id);
      const signal = await started.promise;
      if (action === 'edit') {
        data.store.saveContact({
          ...data.contact,
          traits: { ...data.contact.traits, communication: '用户修订' },
          traitsRevision: 1,
        });
      } else if (action === 'pause') {
        data.store.saveConversation({
          ...data.store.conversation(data.conversation.id)!,
          paused: true,
        });
        engine.cancel(data.conversation.id);
      } else {
        data.store.addMessage(data.message('2'));
        engine.notify(data.conversation.id);
      }
      response.resolve(consolidation);
      if (action === 'edit') {
        await completed.promise;
        assert.equal(data.store.contact(data.contact.id)?.traits.communication, '用户修订');
      } else {
        assert.equal(signal.aborted, true);
        await engine.stop();
        assert.equal(data.store.contact(data.contact.id)?.traitsRevision, 0);
        assert.equal(data.store.conversation(data.conversation.id)?.consolidatedSequence, 0);
      }
    } finally {
      response.resolve(consolidation);
      await engine.stop();
      data.cleanup();
    }
  });
}

for (const stage of ['summary', 'gate', 'advice', 'consolidate'] as const) {
  test(`${stage} 取图失败不推进对应检查点，重试保留图片内容`, { timeout: 5000 }, async () => {
    const data = fixture();
    let fail = true;
    const failed = watcher(
      () => data.store.conversation(data.conversation.id)?.status === '分析失败',
    );
    const completed = watcher(
      () => (data.store.conversation(data.conversation.id)?.consolidatedSequence ?? 0) > 0,
    );
    const ai = new FakeAi(async (instruction, signal, payload) => {
      await buildContextContent(
        payload,
        async () => {
          if (instruction === prompts[stage] && fail) throw new Error('测试图片暂时不可用');
          return 'https://example.invalid/picture.png';
        },
        signal,
      );
      if (instruction === prompts.summary) return light;
      if (instruction === prompts.gate) return { needed: true, reason: '需要跟进', keywords: [] };
      if (instruction === prompts.advice) return { analysis: '根据图文判断', advice: '确认安排' };
      return consolidation;
    });
    const engine = new AnalysisEngine(data.store, ai, () => {
      failed.changed();
      completed.changed();
    });
    try {
      data.store.addMessage({
        ...data.message('1'),
        segments: [
          { type: 'text', text: '看这张图片' },
          { type: 'image', file: 'test.png' },
        ],
      });
      engine.flush(data.conversation.id);
      await failed.promise;
      const conversation = data.store.conversation(data.conversation.id)!;
      assert.match(conversation.error, /无法读取消息图片/);
      assert.equal(conversation.consolidatedSequence, 0);
      if (stage === 'summary') assert.equal(conversation.processedSequence, 0);
      else assert.ok(conversation.processedSequence > 0);
      if (stage !== 'consolidate') assert.equal(conversation.lastDecisionSequence, 0);
      else assert.ok(conversation.lastDecisionSequence > 0);
      fail = false;
      engine.flush(data.conversation.id);
      await completed.promise;
      assert.equal(data.store.decisions(data.conversation.id).length, 1);
    } finally {
      await engine.stop();
      data.cleanup();
    }
  });
}

for (const action of ['pause', 'new-message'] as const) {
  test(`取图期间 ${action} 取消旧任务，旧图片返回后不写入摘要`, { timeout: 5000 }, async () => {
    const data = fixture();
    const started = deferred<AbortSignal>();
    const staleImage = deferred<string>();
    let first = true;
    const completed = watcher(
      () => (data.store.conversation(data.conversation.id)?.processedSequence ?? 0) > 0,
    );
    const ai = new FakeAi(async (instruction, signal, payload) => {
      await buildContextContent(
        payload,
        async () => {
          if (first) {
            first = false;
            started.resolve(signal);
            return staleImage.promise;
          }
          return 'https://example.invalid/new.png';
        },
        signal,
      );
      return instruction === prompts.summary
        ? light
        : instruction === prompts.gate
          ? { needed: false, reason: '无需建议', keywords: [] }
          : consolidation;
    });
    const engine = new AnalysisEngine(data.store, ai, completed.changed);
    try {
      data.store.addMessage({
        ...data.message('1'),
        segments: [{ type: 'image', file: 'one.png' }],
      });
      engine.flush(data.conversation.id);
      const signal = await started.promise;
      if (action === 'pause') {
        data.store.saveConversation({
          ...data.store.conversation(data.conversation.id)!,
          paused: true,
        });
        engine.cancel(data.conversation.id);
      } else {
        data.store.addMessage(data.message('2'));
        engine.flush(data.conversation.id);
        await completed.promise;
      }
      assert.equal(signal.aborted, true);
      staleImage.resolve('https://example.invalid/old.png');
      await engine.stop();
      assert.equal(
        data.store.observations(data.conversation.id).length,
        action === 'pause' ? 0 : 1,
      );
      if (action === 'pause')
        assert.equal(data.store.conversation(data.conversation.id)?.processedSequence, 0);
      else assert.equal(data.store.conversation(data.conversation.id)?.summary, light.summary);
    } finally {
      staleImage.resolve('https://example.invalid/old.png');
      await engine.stop();
      data.cleanup();
    }
  });
}

for (const [stage, label] of [
  ['summary', '摘要更新'],
  ['gate', '建议必要性判断'],
  ['advice', '详细建议生成'],
  ['consolidate', '画像与记忆归纳'],
] as const) {
  test(`${label} 保留请求失败步骤和安全原因，不推进失败阶段进度`, { timeout: 5000 }, async () => {
    const data = fixture();
    const failed = watcher(
      () => data.store.conversation(data.conversation.id)?.status === '分析失败',
    );
    const ai = new FakeAi((instruction) => {
      if (instruction === prompts[stage])
        throw new AiCallError('HTTP 响应', 'AI 服务返回 HTTP 429，请检查额度或请求频率。');
      if (instruction === prompts.summary) return light;
      if (instruction === prompts.gate) return { needed: true, reason: '需要跟进', keywords: [] };
      if (instruction === prompts.advice) return { analysis: '根据聊天判断', advice: '确认安排' };
      return consolidation;
    });
    const engine = new AnalysisEngine(data.store, ai, failed.changed);
    try {
      data.store.addMessage(data.message('1'));
      engine.flush(data.conversation.id);
      await failed.promise;
      const conversation = data.store.conversation(data.conversation.id)!;
      assert.ok(conversation.error.includes(`${label}失败（步骤：HTTP 响应）`));
      assert.match(conversation.error, /429/);
      assert.equal(conversation.consolidatedSequence, 0);
      if (stage === 'summary') assert.equal(conversation.processedSequence, 0);
      if (stage === 'gate' || stage === 'advice')
        assert.equal(conversation.lastDecisionSequence, 0);
    } finally {
      await engine.stop();
      data.cleanup();
    }
  });
}

test('未知分析异常不向页面暴露原始聊天或密钥', { timeout: 5000 }, async () => {
  const data = fixture();
  const failed = watcher(
    () => data.store.conversation(data.conversation.id)?.status === '分析失败',
  );
  const ai = new FakeAi(() => {
    throw new Error('invalid-private-test-detail');
  });
  const engine = new AnalysisEngine(data.store, ai, failed.changed);
  try {
    data.store.addMessage(data.message('1'));
    engine.flush(data.conversation.id);
    await failed.promise;
    const error = data.store.conversation(data.conversation.id)?.error ?? '';
    assert.match(error, /摘要更新失败.*AI 调用/);
    assert.equal(error.includes('invalid-private-test-detail'), false);
    assert.equal(data.store.conversation(data.conversation.id)?.processedSequence, 0);
  } finally {
    await engine.stop();
    data.cleanup();
  }
});

test(
  '默认少量消息分别在静默 60、120、600 秒触发三个阶段，且不重复调用',
  { timeout: 5000 },
  async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const data = fixture();
    const summarized = watcher(
      () => data.store.conversation(data.conversation.id)!.processedSequence > 0,
    );
    const decided = watcher(() =>
      data.store
        .decisions(data.conversation.id)
        .some((decision) => decision.trigger === '对话静默'),
    );
    const consolidated = watcher(
      () => data.store.conversation(data.conversation.id)!.consolidatedSequence > 0,
    );
    const ai = new FakeAi((instruction) =>
      instruction === prompts.summary
        ? light
        : instruction === prompts.gate
          ? { needed: false, reason: '普通聊天，无需建议', keywords: [] }
          : consolidation,
    );
    const engine = new AnalysisEngine(data.store, ai, () => {
      summarized.changed();
      decided.changed();
      consolidated.changed();
    });
    try {
      data.store.addMessage(data.message('1'));
      engine.notify(data.conversation.id);
      context.mock.timers.tick(59999);
      assert.deepEqual(ai.calls, []);
      context.mock.timers.tick(1);
      await summarized.promise;
      assert.deepEqual(ai.calls, [prompts.summary]);
      assert.equal(data.store.conversation(data.conversation.id)!.consolidatedSequence, 0);
      context.mock.timers.tick(60000);
      await decided.promise;
      assert.deepEqual(ai.calls, [prompts.summary, prompts.gate]);
      assert.equal(data.store.conversation(data.conversation.id)!.consolidatedSequence, 0);
      context.mock.timers.tick(480000);
      await consolidated.promise;
      assert.deepEqual(ai.calls, [prompts.summary, prompts.gate, prompts.consolidate]);
      context.mock.timers.tick(3600000);
      await engine.stop();
      assert.equal(ai.calls.length, 3);
    } finally {
      await engine.stop();
      context.mock.timers.reset();
      data.cleanup();
    }
  },
);

test(
  '持续聊天到第 20 条直接更新摘要，不等待 60 秒合并，也不提前归纳',
  { timeout: 5000 },
  async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const data = fixture();
    const summarized = watcher(
      () => data.store.conversation(data.conversation.id)!.processedSequence > 0,
    );
    const ai = new FakeAi(() => light);
    const engine = new AnalysisEngine(data.store, ai, summarized.changed);
    try {
      for (let index = 1; index <= 19; index++) {
        data.store.addMessage(data.message(String(index)));
        engine.notify(data.conversation.id);
        context.mock.timers.tick(1000);
      }
      assert.deepEqual(ai.calls, []);
      data.store.addMessage(data.message('20'));
      engine.notify(data.conversation.id);
      context.mock.timers.tick(0);
      await summarized.promise;
      assert.deepEqual(ai.calls, [prompts.summary]);
      assert.equal(data.store.decisions(data.conversation.id).length, 1);
      assert.equal(data.store.decisions(data.conversation.id)[0]?.trigger, '摘要建议预筛');
      assert.equal(data.store.conversation(data.conversation.id)!.lastDecisionSequence, 0);
      assert.equal(
        ai.calls.some((call) => call === prompts.gate),
        false,
      );
      assert.equal(data.store.conversation(data.conversation.id)!.consolidatedSequence, 0);
    } finally {
      await engine.stop();
      context.mock.timers.reset();
      data.cleanup();
    }
  },
);

test(
  '归纳 100 条阈值跨越 60 条分页，历史归纳不触发建议且逐页保存检查点',
  { timeout: 5000 },
  async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const data = fixture();
    data.store.settings = { ...data.store.settings, summaryMessageThreshold: 200 };
    const completed = watcher(
      () => data.store.conversation(data.conversation.id)!.consolidatedSequence >= 100,
    );
    const batches: number[] = [];
    const ai = new FakeAi((instruction, _signal, payload) => {
      if (instruction === prompts.summary) return light;
      assert.equal(instruction, prompts.consolidate);
      batches.push(z.object({ messages: z.array(z.unknown()) }).parse(payload).messages.length);
      return {
        traits: data.contact.traits,
        traitSourceIds: { likes: [], boundaries: [], communication: [] },
        memories: [],
      };
    });
    const engine = new AnalysisEngine(data.store, ai, completed.changed);
    try {
      for (let index = 1; index <= 100; index++)
        data.store.addMessage({ ...data.message(String(index)), source: 'history' });
      engine.notify(data.conversation.id, false);
      context.mock.timers.tick(0);
      await completed.promise;
      assert.deepEqual(batches, [60, 40]);
      assert.equal(ai.calls.filter((instruction) => instruction === prompts.summary).length, 2);
      assert.equal(data.store.decisions(data.conversation.id).length, 0);
      assert.equal(data.store.conversation(data.conversation.id)!.processedSequence, 100);
    } finally {
      await engine.stop();
      context.mock.timers.reset();
      data.cleanup();
    }
  },
);

test(
  '较短合并窗口不会绕过摘要节流，后续消息会重置所有静默计时',
  { timeout: 5000 },
  async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const data = fixture();
    data.store.settings = { ...data.store.settings, mergeWindowSeconds: 3 };
    const merged = watcher(
      () => engine.activity(data.conversation.id).at(-1)?.status === 'completed',
    );
    const summarized = watcher(
      () => data.store.conversation(data.conversation.id)!.processedSequence > 0,
    );
    const ai = new FakeAi(() => light);
    const engine = new AnalysisEngine(data.store, ai, () => {
      merged.changed();
      summarized.changed();
    });
    try {
      data.store.addMessage(data.message('1'));
      engine.notify(data.conversation.id);
      context.mock.timers.tick(3000);
      await merged.promise;
      assert.deepEqual(ai.calls, []);
      context.mock.timers.tick(56000);
      data.store.addMessage(data.message('2'));
      engine.notify(data.conversation.id);
      context.mock.timers.tick(59999);
      assert.deepEqual(ai.calls, []);
      context.mock.timers.tick(1);
      await summarized.promise;
      assert.deepEqual(ai.calls, [prompts.summary]);
      assert.equal(data.store.observations(data.conversation.id)[0]?.sourceIds.length, 2);
    } finally {
      await engine.stop();
      context.mock.timers.reset();
      data.cleanup();
    }
  },
);

test('静默计时到期等待在途摘要，不取消或重复摘要请求', { timeout: 5000 }, async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const data = fixture();
  const response = deferred<unknown>();
  const started = deferred<AbortSignal>();
  const decided = watcher(() =>
    data.store.decisions(data.conversation.id).some((decision) => decision.trigger === '对话静默'),
  );
  const ai = new FakeAi((instruction, signal) => {
    if (instruction === prompts.summary) {
      started.resolve(signal);
      return response.promise;
    }
    assert.equal(instruction, prompts.gate);
    return { needed: false, reason: '无需建议', keywords: [] };
  });
  const engine = new AnalysisEngine(data.store, ai, decided.changed);
  try {
    data.store.addMessage(data.message('1'));
    engine.notify(data.conversation.id);
    context.mock.timers.tick(60000);
    const signal = await started.promise;
    context.mock.timers.tick(60000);
    assert.equal(signal.aborted, false);
    assert.deepEqual(ai.calls, [prompts.summary]);
    response.resolve(light);
    await decided.promise;
    assert.deepEqual(ai.calls, [prompts.summary, prompts.gate]);
  } finally {
    response.resolve(light);
    await engine.stop();
    context.mock.timers.reset();
    data.cleanup();
  }
});

for (const pause of ['contact', 'conversation'] as const) {
  test(`暂停 ${pause} 清理三个静默计时，恢复后可处理积压`, { timeout: 5000 }, async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const data = fixture();
    const summarized = watcher(
      () => data.store.conversation(data.conversation.id)!.processedSequence > 0,
    );
    const ai = new FakeAi(() => light);
    const engine = new AnalysisEngine(data.store, ai, summarized.changed);
    try {
      data.store.addMessage(data.message('1'));
      engine.notify(data.conversation.id);
      if (pause === 'contact') data.store.saveContact({ ...data.contact, paused: true });
      else data.store.saveConversation({ ...data.conversation, paused: true });
      engine.cancel(data.conversation.id);
      context.mock.timers.tick(3600000);
      assert.deepEqual(ai.calls, []);
      if (pause === 'contact') data.store.saveContact({ ...data.contact, paused: false });
      else data.store.saveConversation({ ...data.conversation, paused: false });
      engine.notify(data.conversation.id);
      context.mock.timers.tick(60000);
      await summarized.promise;
      assert.deepEqual(ai.calls, [prompts.summary]);
    } finally {
      await engine.stop();
      context.mock.timers.reset();
      data.cleanup();
    }
  });
}

test(
  '多轮摘要仅调用一次摘要模型，下一轮基于上次合并摘要继续压缩且始终有长度上限',
  { timeout: 5000 },
  async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const data = fixture();
    data.store.settings = {
      ...data.store.settings,
      summaryMessageThreshold: 2,
      messageThreshold: 200,
      consolidationMessageThreshold: 1000,
    };
    data.store.saveConversation({ ...data.conversation, summary: '旧'.repeat(1000) });
    let expected = data.store.conversation(data.conversation.id)!.summary;
    let expectedSequence = 0;
    let completed = deferred<void>();
    const lengths: number[] = [];
    const ai = new FakeAi((instruction, _signal, payload) => {
      assert.equal(instruction, prompts.summary);
      const input = z
        .object({
          previousSummary: z.string(),
          summaryBudget: z.object({ retainedCharacters: z.number() }),
        })
        .parse(payload);
      assert.equal(input.previousSummary, expected);
      const budget = Math.min(600, Math.floor(expected.length * 0.65));
      assert.equal(input.summaryBudget.retainedCharacters, budget);
      const compressedPreviousSummary = expected.slice(0, budget);
      expected = `${compressedPreviousSummary}\n${'新'.repeat(120)}`;
      return { ...light, compressedPreviousSummary, summary: '新'.repeat(120) };
    });
    const engine = new AnalysisEngine(data.store, ai, () => {
      if (engine.activity(data.conversation.id).at(-1)?.status === 'completed') completed.resolve();
    });
    try {
      for (let round = 0; round < 4; round++) {
        completed = deferred<void>();
        for (let index = 0; index < 2; index++)
          data.store.addMessage(data.message(String(++expectedSequence)));
        engine.notify(data.conversation.id);
        context.mock.timers.tick(0);
        await completed.promise;
        const current = data.store.conversation(data.conversation.id)!;
        assert.equal(current.summary, expected);
        assert.equal(current.processedSequence, expectedSequence);
        assert.ok(current.summary.length <= 1000);
        lengths.push(current.summary.length);
      }
      assert.equal(ai.calls.length, 4);
      assert.ok(lengths.every((length, index) => index === 0 || length < lengths[index - 1]!));
    } finally {
      await engine.stop();
      context.mock.timers.reset();
      data.cleanup();
    }
  },
);

for (const part of ['old', 'new'] as const) {
  test(`拒绝 ${part} 摘要超出压缩预算，保留原摘要与进度并允许重试`, { timeout: 5000 }, async () => {
    const data = fixture();
    const original = '原'.repeat(100);
    data.store.saveConversation({ ...data.conversation, summary: original });
    const failed = watcher(
      () => data.store.conversation(data.conversation.id)?.status === '分析失败',
    );
    const completed = watcher(
      () => data.store.conversation(data.conversation.id)!.consolidatedSequence > 0,
    );
    let retry = false;
    const ai = new FakeAi((instruction) => {
      if (instruction === prompts.summary)
        return {
          ...light,
          compressedPreviousSummary: !retry && part === 'old' ? '旧'.repeat(66) : '旧',
          summary: !retry && part === 'new' ? '新'.repeat(381) : '新',
        };
      if (instruction === prompts.gate) return { needed: false, reason: '无需建议', keywords: [] };
      return { traits: {}, traitSourceIds: {}, memories: [] };
    });
    const engine = new AnalysisEngine(data.store, ai, () => {
      failed.changed();
      completed.changed();
    });
    try {
      data.store.addMessage(data.message('1'));
      engine.flush(data.conversation.id);
      await failed.promise;
      assert.equal(data.store.conversation(data.conversation.id)!.summary, original);
      assert.equal(data.store.conversation(data.conversation.id)!.processedSequence, 0);
      assert.equal(data.store.observations(data.conversation.id).length, 0);
      retry = true;
      engine.flush(data.conversation.id);
      await completed.promise;
      assert.equal(data.store.conversation(data.conversation.id)!.summary, '旧\n新');
    } finally {
      await engine.stop();
      data.cleanup();
    }
  });
}

test('旧版六千字符摘要首次整体交给压缩模型，成功后转为紧凑摘要', { timeout: 5000 }, async () => {
  const data = fixture();
  const original = `开头${'中'.repeat(5996)}结尾`;
  data.store.saveConversation({ ...data.conversation, summary: original });
  const completed = watcher(
    () => data.store.conversation(data.conversation.id)!.consolidatedSequence > 0,
  );
  const ai = new FakeAi((instruction, _signal, payload) => {
    if (instruction === prompts.summary) {
      const input = z.object({ previousSummary: z.string() }).parse(payload);
      assert.equal(input.previousSummary, original);
      return { ...light, compressedPreviousSummary: '之前仍有未完成约定' };
    }
    if (instruction === prompts.gate) return { needed: false, reason: '无需建议', keywords: [] };
    return consolidation;
  });
  const engine = new AnalysisEngine(data.store, ai, completed.changed);
  try {
    data.store.addMessage(data.message('1'));
    engine.flush(data.conversation.id);
    await completed.promise;
    assert.ok(data.store.conversation(data.conversation.id)!.summary.length <= 1000);
  } finally {
    await engine.stop();
    data.cleanup();
  }
});

test(
  '建议判断只携带紧凑摘要、变化指标及六条证据，详细建议仍有原始消息',
  { timeout: 5000 },
  async () => {
    const data = fixture();
    const completed = watcher(
      () => data.store.conversation(data.conversation.id)!.consolidatedSequence > 0,
    );
    const ai = new FakeAi((instruction, _signal, payload) => {
      if (instruction === prompts.summary) return light;
      if (instruction === prompts.gate) {
        const input = z
          .object({
            summary: z.string().max(1000),
            messages: z
              .array(z.object({ text: z.string().max(500), senderRole: z.string() }))
              .max(6),
            signals: z.object({
              attitude: z.number(),
              attitudeChange: z.number().nullable(),
              reason: z.string().max(300),
            }),
            evidenceCoverage: z.object({ totalMessages: z.number(), selectedMessages: z.number() }),
          })
          .parse(payload);
        assert.equal(input.messages.length, 6);
        assert.equal(input.evidenceCoverage.totalMessages, 40);
        assert.equal(input.evidenceCoverage.selectedMessages, 6);
        assert.ok(!('self' in z.object({}).passthrough().parse(payload)));
        return { needed: true, reason: '约定需要跟进', keywords: [] };
      }
      if (instruction === prompts.advice) {
        const input = z
          .object({
            messages: z.array(z.object({ text: z.string() })),
            self: z.unknown(),
            contact: z.unknown(),
            evidenceCoverage: z.object({
              selectedMessages: z.number(),
              textIsExcerpted: z.boolean(),
            }),
          })
          .parse(payload);
        assert.equal(input.messages.length, 40);
        assert.equal(input.evidenceCoverage.selectedMessages, 40);
        assert.equal(input.evidenceCoverage.textIsExcerpted, false);
        assert.ok(input.messages.every((message) => message.text.length > 500));
        return { analysis: '根据原始消息', advice: '确认安排' };
      }
      return consolidation;
    });
    const engine = new AnalysisEngine(data.store, ai, completed.changed);
    try {
      for (let index = 1; index <= 40; index++)
        data.store.addMessage(data.message(String(index), '见面安排'.repeat(200)));
      engine.flush(data.conversation.id);
      await completed.promise;
      assert.equal(data.store.decisions(data.conversation.id)[0]?.needed, true);
    } finally {
      await engine.stop();
      data.cleanup();
    }
  },
);

test(
  '归纳仅传相关画像和全历史候选重复记忆，部分画像更新保留未提供字段',
  { timeout: 5000 },
  async () => {
    const data = fixture();
    const traits = {
      likes: '偏好阅读小说',
      boundaries: '不公开家庭住址',
      communication: '先写文字再交流',
    };
    data.store.saveContact({ ...data.contact, traits });
    for (let index = 0; index < 70; index++)
      data.store.saveMemory({
        id: String(index),
        contactId: data.contact.id,
        kind: 'promise',
        text: index === 0 ? '周六在公园见面' : '更新服务器配置文件',
        keywords: index === 0 ? ['周六', '公园'] : ['服务器'],
        time: index,
        createdAt: index,
        sourceIds: ['old'],
      });
    const completed = watcher(
      () => data.store.conversation(data.conversation.id)!.consolidatedSequence > 0,
    );
    const ai = new FakeAi((instruction, _signal, payload) => {
      if (instruction === prompts.summary) return light;
      if (instruction === prompts.gate) return { needed: false, reason: '无需建议', keywords: [] };
      const input = z
        .object({
          traits: z.record(z.string()),
          existingMemories: z.array(z.object({ id: z.string() })),
          contact: z.object({}).passthrough(),
        })
        .passthrough()
        .parse(payload);
      assert.deepEqual(input.traits, { likes: traits.likes });
      assert.deepEqual(
        input.existingMemories.map((memory) => memory.id),
        ['0'],
      );
      assert.equal('summary' in input, false);
      assert.equal('traits' in input.contact, false);
      assert.equal('self' in input, false);
      return {
        traits: { likes: '偏好阅读小说，也喜欢登山' },
        traitSourceIds: { likes: ['1'] },
        memories: [],
      };
    });
    const engine = new AnalysisEngine(data.store, ai, completed.changed);
    try {
      data.store.addMessage(data.message('1', '我喜欢登山，周六在公园见面改到周日。'));
      engine.flush(data.conversation.id);
      await completed.promise;
      assert.deepEqual(data.store.contact(data.contact.id)!.traits, {
        ...traits,
        likes: '偏好阅读小说，也喜欢登山',
      });
    } finally {
      await engine.stop();
      data.cleanup();
    }
  },
);

test(
  '归纳拒绝覆盖未提供画像字段，即使带有效消息来源也不推进记忆检查点',
  { timeout: 5000 },
  async () => {
    const data = fixture();
    const traits = {
      likes: '偏好阅读小说',
      boundaries: '不公开家庭住址',
      communication: '先写文字再交流',
    };
    data.store.saveContact({ ...data.contact, traits });
    const failed = watcher(
      () => data.store.conversation(data.conversation.id)?.status === '分析失败',
    );
    const completed = watcher(
      () => data.store.conversation(data.conversation.id)!.consolidatedSequence > 0,
    );
    let retry = false;
    const ai = new FakeAi((instruction) => {
      if (instruction === prompts.summary) return light;
      if (instruction === prompts.gate) return { needed: false, reason: '无需建议', keywords: [] };
      return {
        traits: retry ? {} : { boundaries: '' },
        traitSourceIds: { boundaries: ['1'] },
        memories: [],
      };
    });
    const engine = new AnalysisEngine(data.store, ai, () => {
      failed.changed();
      completed.changed();
    });
    try {
      data.store.addMessage(data.message('1', '我喜欢登山。'));
      engine.flush(data.conversation.id);
      await failed.promise;
      assert.match(data.store.conversation(data.conversation.id)!.error, /未提供的画像字段/);
      assert.equal(data.store.conversation(data.conversation.id)!.consolidatedSequence, 0);
      assert.equal(data.store.conversation(data.conversation.id)!.processedSequence, 1);
      assert.deepEqual(data.store.contact(data.contact.id)!.traits, traits);
      retry = true;
      engine.flush(data.conversation.id);
      await completed.promise;
      assert.deepEqual(data.store.contact(data.contact.id)!.traits, traits);
    } finally {
      await engine.stop();
      data.cleanup();
    }
  },
);

for (const needed of [true, false]) {
  test(
    `摘要肯定信号提前进入建议判断，判断 needed=${needed} 时按需生成`,
    { timeout: 5000 },
    async (context) => {
      context.mock.timers.enable({ apis: ['setTimeout'] });
      const data = fixture();
      data.store.settings = { ...data.store.settings, summaryMessageThreshold: 2 };
      const done = deferred<void>();
      const ai = new FakeAi((instruction) => {
        if (instruction === prompts.summary)
          return {
            ...light,
            adviceSignal: { worthChecking: true, reason: '存在待确认的见面安排' },
          };
        if (instruction === prompts.gate)
          return { needed, reason: '进一步判断的依据', keywords: ['见面'] };
        assert.equal(instruction, prompts.advice);
        return { analysis: '约定需要确认', advice: '确认双方时间' };
      });
      const engine = new AnalysisEngine(data.store, ai, () => {
        if (engine.activity(data.conversation.id).at(-1)?.status === 'completed') done.resolve();
      });
      try {
        data.store.addMessage(data.message('1'));
        data.store.addMessage(data.message('2'));
        engine.notify(data.conversation.id);
        context.mock.timers.tick(0);
        await done.promise;
        assert.deepEqual(
          ai.calls,
          needed
            ? [prompts.summary, prompts.gate, prompts.advice]
            : [prompts.summary, prompts.gate],
        );
        assert.equal(data.store.decisions(data.conversation.id)[0]?.trigger, '摘要建议预筛');
        assert.equal(data.store.decisions(data.conversation.id)[0]?.needed, needed);
        assert.equal(data.store.conversation(data.conversation.id)!.lastDecisionSequence, 2);
        assert.equal(data.store.conversation(data.conversation.id)!.consolidatedSequence, 0);
      } finally {
        await engine.stop();
        context.mock.timers.reset();
        data.cleanup();
      }
    },
  );
}

for (const trigger of ['manual', 'idle', 'threshold', 'significant'] as const) {
  test(`摘要否定信号不阻止 ${trigger} 独立建议判断`, { timeout: 5000 }, async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const data = fixture();
    data.store.settings = {
      ...data.store.settings,
      summaryMessageThreshold: 2,
      messageThreshold: trigger === 'threshold' ? 2 : 30,
    };
    const done = watcher(() =>
      data.store
        .decisions(data.conversation.id)
        .some((decision) => decision.trigger !== '摘要建议预筛'),
    );
    const ai = new FakeAi((instruction) =>
      instruction === prompts.summary
        ? { ...light, significant: trigger === 'significant' }
        : instruction === prompts.gate
          ? { needed: false, reason: '独立检查确认无需介入', keywords: [] }
          : consolidation,
    );
    const engine = new AnalysisEngine(data.store, ai, done.changed);
    try {
      data.store.addMessage(data.message('1'));
      if (trigger === 'threshold' || trigger === 'significant')
        data.store.addMessage(data.message('2'));
      if (trigger === 'manual') engine.flush(data.conversation.id);
      else {
        engine.notify(data.conversation.id);
        context.mock.timers.tick(trigger === 'idle' ? 120000 : 0);
      }
      await done.promise;
      assert.equal(ai.calls.filter((call) => call === prompts.gate).length, 1);
      const decision = data.store.decisions(data.conversation.id).at(-1)!;
      assert.equal(decision.reason, '独立检查确认无需介入');
      assert.equal(
        decision.trigger,
        {
          manual: '手动检查',
          idle: '对话静默',
          threshold: '消息数量阈值',
          significant: '明显态度/情绪变化',
        }[trigger],
      );
      assert.equal(
        data.store.conversation(data.conversation.id)!.lastDecisionSequence,
        trigger === 'threshold' || trigger === 'significant' ? 2 : 1,
      );
    } finally {
      await engine.stop();
      context.mock.timers.reset();
      data.cleanup();
    }
  });
}

for (const kind of ['history', 'unrelated-group'] as const) {
  test(`摘要肯定信号不绕过 ${kind} 的建议限制`, { timeout: 5000 }, async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const data = fixture();
    data.store.settings = { ...data.store.settings, summaryMessageThreshold: 2 };
    if (kind === 'unrelated-group')
      data.store.saveConversation({ ...data.conversation, kind: 'group' });
    const done = deferred<void>();
    const ai = new FakeAi((instruction) => {
      assert.equal(instruction, prompts.summary);
      return {
        ...light,
        relevant: kind !== 'unrelated-group',
        adviceSignal: { worthChecking: true, reason: '应当被历史或相关性规则拦截' },
      };
    });
    const engine = new AnalysisEngine(data.store, ai, () => {
      if (engine.activity(data.conversation.id).at(-1)?.status === 'completed') done.resolve();
    });
    try {
      for (const id of ['1', '2'])
        data.store.addMessage({
          ...data.message(id),
          source: kind === 'history' ? 'history' : 'live',
        });
      engine.notify(data.conversation.id);
      context.mock.timers.tick(0);
      await done.promise;
      assert.deepEqual(ai.calls, [prompts.summary]);
      assert.equal(data.store.decisions(data.conversation.id).length, 0);
      assert.equal(data.store.conversation(data.conversation.id)!.lastDecisionSequence, 0);
    } finally {
      await engine.stop();
      context.mock.timers.reset();
      data.cleanup();
    }
  });
}

test('多页摘要中后续否定信号不会覆盖前页肯定信号', { timeout: 5000 }, async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const data = fixture();
  data.store.settings = { ...data.store.settings, messageThreshold: 200 };
  const done = deferred<void>();
  let summaries = 0;
  const ai = new FakeAi((instruction) => {
    if (instruction === prompts.summary)
      return {
        ...light,
        adviceSignal: {
          worthChecking: ++summaries === 1,
          reason: summaries === 1 ? '第一批存在待处理约定' : '最后一批只是闲聊',
        },
      };
    assert.equal(instruction, prompts.gate);
    return { needed: false, reason: '综合后无需建议', keywords: [] };
  });
  const engine = new AnalysisEngine(data.store, ai, () => {
    if (engine.activity(data.conversation.id).at(-1)?.status === 'completed') done.resolve();
  });
  try {
    for (let index = 1; index <= 61; index++) data.store.addMessage(data.message(String(index)));
    engine.notify(data.conversation.id);
    context.mock.timers.tick(0);
    await done.promise;
    assert.deepEqual(ai.calls, [prompts.summary, prompts.summary, prompts.gate]);
    assert.equal(data.store.conversation(data.conversation.id)!.lastDecisionSequence, 61);
    assert.ok(
      engine
        .activity(data.conversation.id)
        .at(-1)
        ?.steps.some(
          (step) => step.label === '摘要建议预筛' && step.detail === '第一批存在待处理约定',
        ),
    );
  } finally {
    await engine.stop();
    context.mock.timers.reset();
    data.cleanup();
  }
});

test('新消息取消旧摘要，迟到的肯定信号不会触发建议判断', { timeout: 5000 }, async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const data = fixture();
  data.store.settings = { ...data.store.settings, summaryMessageThreshold: 2 };
  const started = deferred<AbortSignal>(),
    stale = deferred<unknown>(),
    done = deferred<void>();
  let summaries = 0;
  const ai = new FakeAi((instruction, signal) => {
    assert.equal(instruction, prompts.summary);
    if (++summaries === 1) {
      started.resolve(signal);
      return stale.promise;
    }
    return light;
  });
  const engine = new AnalysisEngine(data.store, ai, () => {
    if (engine.activity(data.conversation.id).at(-1)?.status === 'completed') done.resolve();
  });
  try {
    data.store.addMessage(data.message('1'));
    data.store.addMessage(data.message('2'));
    engine.notify(data.conversation.id);
    context.mock.timers.tick(0);
    const oldSignal = await started.promise;
    data.store.addMessage(data.message('3'));
    engine.notify(data.conversation.id);
    context.mock.timers.tick(0);
    await done.promise;
    assert.equal(oldSignal.aborted, true);
    stale.resolve({ ...light, adviceSignal: { worthChecking: true, reason: '过期信号' } });
    await engine.stop();
    assert.equal(ai.calls.includes(prompts.gate), false);
    assert.equal(data.store.decisions(data.conversation.id).length, 1);
    assert.equal(data.store.decisions(data.conversation.id)[0]?.reason, light.adviceSignal.reason);
    assert.equal(data.store.conversation(data.conversation.id)!.lastDecisionSequence, 0);
  } finally {
    stale.resolve(light);
    await engine.stop();
    context.mock.timers.reset();
    data.cleanup();
  }
});

test(
  '摘要缺失预筛字段不推进摘要进度；建议判断失败后可不重复摘要地重试',
  { timeout: 5000 },
  async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const data = fixture();
    data.store.settings = { ...data.store.settings, summaryMessageThreshold: 2 };
    let phase: 'missing' | 'gate-failure' | 'success' = 'missing';
    let failed = deferred<void>();
    const done = watcher(
      () => data.store.conversation(data.conversation.id)!.consolidatedSequence > 0,
    );
    const ai = new FakeAi((instruction) => {
      if (instruction === prompts.summary) {
        if (phase === 'missing') {
          const { adviceSignal: _signal, ...legacy } = light;
          return legacy;
        }
        return { ...light, adviceSignal: { worthChecking: true, reason: '需要进一步判断' } };
      }
      if (instruction === prompts.gate) {
        if (phase === 'gate-failure')
          throw new AiCallError('HTTP 响应', 'AI 服务返回 HTTP 429，请检查额度或请求频率。');
        return { needed: false, reason: '重试后无需建议', keywords: [] };
      }
      return consolidation;
    });
    const engine = new AnalysisEngine(data.store, ai, () => {
      if (engine.activity(data.conversation.id).at(-1)?.status === 'failed') failed.resolve();
      done.changed();
    });
    try {
      data.store.addMessage(data.message('1'));
      data.store.addMessage(data.message('2'));
      engine.notify(data.conversation.id);
      context.mock.timers.tick(0);
      await failed.promise;
      assert.equal(data.store.conversation(data.conversation.id)!.processedSequence, 0);
      assert.equal(data.store.observations(data.conversation.id).length, 0);
      failed = deferred<void>();
      phase = 'gate-failure';
      engine.flush(data.conversation.id);
      await failed.promise;
      assert.equal(data.store.conversation(data.conversation.id)!.processedSequence, 2);
      assert.equal(data.store.conversation(data.conversation.id)!.lastDecisionSequence, 0);
      phase = 'success';
      engine.flush(data.conversation.id);
      await done.promise;
      assert.equal(ai.calls.filter((call) => call === prompts.summary).length, 2);
      assert.equal(ai.calls.filter((call) => call === prompts.gate).length, 2);
      assert.equal(data.store.conversation(data.conversation.id)!.lastDecisionSequence, 2);
    } finally {
      await engine.stop();
      context.mock.timers.reset();
      data.cleanup();
    }
  },
);

test('摘要否定信号仅结束建议入口，不停止独立到期的记忆归纳', { timeout: 5000 }, async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const data = fixture();
  data.store.settings = {
    ...data.store.settings,
    summaryMessageThreshold: 2,
    consolidationMessageThreshold: 2,
  };
  const done = watcher(
    () => data.store.conversation(data.conversation.id)!.consolidatedSequence > 0,
  );
  const ai = new FakeAi((instruction) => (instruction === prompts.summary ? light : consolidation));
  const engine = new AnalysisEngine(data.store, ai, done.changed);
  try {
    data.store.addMessage(data.message('1'));
    data.store.addMessage(data.message('2'));
    engine.notify(data.conversation.id);
    context.mock.timers.tick(0);
    await done.promise;
    assert.deepEqual(ai.calls, [prompts.summary, prompts.consolidate]);
    assert.equal(data.store.decisions(data.conversation.id)[0]?.reason, light.adviceSignal.reason);
    assert.equal(data.store.conversation(data.conversation.id)!.lastDecisionSequence, 0);
    assert.equal(data.store.conversation(data.conversation.id)!.consolidatedSequence, 2);
  } finally {
    await engine.stop();
    context.mock.timers.reset();
    data.cleanup();
  }
});
