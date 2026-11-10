import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import sharp from 'sharp';
import { AnalysisEngine, retrieveMemories } from '../server/engine.js';
import { ImageAnalysisService } from '../server/image-analysis.js';
import { imageCachePolicy } from '../server/image-cache.js';
import { buildContextContent } from '../server/ai-context.js';
import { AiCallError, prompts, type AiClient } from '../server/ai.js';
import { Store } from '../server/store.js';
import { fixture, deferred } from './helpers.js';

const summary = {
  adviceSignal: { worthChecking: false, reason: '普通讨论，暂不值得进一步判断' },
  compressedPreviousSummary: '',
  summary: '双方确认周六见面',
  relevant: true,
  significant: false,
  attitude: 10,
  emotion: 5,
  mood: '平静',
  reason: '对象确认约定',
};
const result = {
  description: '图片中写着：周六下午公园见面',
  limitations: '图片不能证明发送者经历或承诺，需结合本人发言',
};
class FakeAi implements AiClient {
  readonly calls: string[] = [];
  constructor(
    private readonly respond: (instruction: string, payload: unknown) => unknown | Promise<unknown>,
  ) {}
  async call<T>(instruction: string, context: unknown, schema: z.ZodType<T>): Promise<T> {
    this.calls.push(instruction);
    return schema.parse(await this.respond(instruction, context));
  }
}

const png = () =>
  sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } })
    .png()
    .toBuffer();

test(
  '各阶段只接收图片文字分析，记忆快照在缓存被清理和数据库重启后仍完整，且仅关联有效来源',
  { timeout: 5000 },
  async () => {
    const data = fixture();
    const bytes = await png();
    let analyses = 0,
      downloads = 0;
    const images = new ImageAnalysisService({
      cache: data.store.imageCache,
      configuration: () => ({ account: '10001', model: 'invalid-test-model' }),
      resolveImage: async (image) => image.url!,
      download: async () => {
        downloads++;
        return bytes;
      },
      analyzeImage: async () => {
        analyses++;
        return result;
      },
    });
    const completed = deferred<void>();
    const ai = new FakeAi(async (instruction, payload) => {
      const content = await buildContextContent(
        payload,
        async () => {
          throw new Error('聊天分析不应再次取图');
        },
        new AbortController().signal,
      );
      assert.ok(Array.isArray(content));
      assert.ok(content.every((part) => part.type === 'text'));
      assert.ok(JSON.stringify(content).includes(result.description));
      if (instruction === prompts.summary) return summary;
      if (instruction === prompts.gate) return { needed: false, reason: '无需建议', keywords: [] };
      // Deliberately evict before the consolidation result returns: evidence must already be detached.
      data.store.imageCache.prune(Date.now() + imageCachePolicy.maxIdleMs + 1);
      assert.equal(data.store.imageCache.size(), 0);
      return {
        traits: {},
        traitSourceIds: {},
        memories: [
          {
            subjectId: data.contact.qq,
            kind: 'promise',
            text: '对象确认周六见面的约定',
            time: 1,
            sourceIds: ['one'],
            keywords: ['约定'],
          },
        ],
      };
    });
    const engine = new AnalysisEngine(
      data.store,
      ai,
      () => {
        if ((data.store.conversation(data.conversation.id)?.consolidatedSequence ?? 0) >= 2)
          completed.resolve();
      },
      images,
    );
    try {
      for (const id of ['one', 'two'])
        data.store.addMessage({
          ...data.message(id, '确认周六见面。'),
          segments: [
            { type: 'text', text: '确认周六见面。' },
            { type: 'image', file: `file-${id}`, url: `https://gchat.qpic.cn/${id}` },
          ],
        });
      engine.flush(data.conversation.id);
      await completed.promise;
      assert.equal(analyses, 1);
      assert.equal(downloads, 2);
      const memory = data.store.memories(data.contact.id)[0]!;
      assert.equal(memory.imageEvidence?.length, 1);
      assert.equal(memory.imageEvidence?.[0]?.messageId, 'one');
      assert.equal(memory.imageEvidence?.[0]?.analysis.description, result.description);
      assert.equal(memory.imageEvidence?.[0]?.senderId, data.contact.qq);
      assert.equal(memory.imageEvidence?.[0]?.segmentIndex, 1);
      const reopened = new Store(data.directory);
      try {
        const saved = reopened.memories(data.contact.id)[0]!;
        assert.deepEqual(saved, memory);
        assert.equal(reopened.imageCache.size(), 0);
        assert.deepEqual(
          retrieveMemories([saved], ['约定'], Date.now())[0]?.imageEvidence,
          memory.imageEvidence,
        );
      } finally {
        reopened.close();
      }
    } finally {
      images.stop();
      await engine.stop();
      data.cleanup();
    }
  },
);

test(
  '首次图片分析失败不推进会话检查点、不缓存失败，重新检查可恢复',
  { timeout: 5000 },
  async () => {
    const data = fixture();
    const bytes = await png();
    let retry = false;
    const failed = deferred<void>(),
      completed = deferred<void>();
    const images = new ImageAnalysisService({
      cache: data.store.imageCache,
      configuration: () => ({ account: '10001', model: 'invalid-test-model' }),
      resolveImage: async (image) => image.url!,
      download: async () => bytes,
      analyzeImage: async () => {
        if (!retry)
          throw new AiCallError('HTTP 响应', 'AI 服务返回 HTTP 429，请检查额度或请求频率。');
        return result;
      },
    });
    const ai = new FakeAi((instruction) =>
      instruction === prompts.summary
        ? summary
        : instruction === prompts.gate
          ? { needed: false, reason: '无需建议', keywords: [] }
          : { traits: {}, traitSourceIds: {}, memories: [] },
    );
    const engine = new AnalysisEngine(
      data.store,
      ai,
      () => {
        const conversation = data.store.conversation(data.conversation.id)!;
        if (conversation.status === '分析失败') failed.resolve();
        if (conversation.consolidatedSequence > 0) completed.resolve();
      },
      images,
    );
    try {
      data.store.addMessage({
        ...data.message('one'),
        segments: [{ type: 'image', url: 'https://gchat.qpic.cn/one' }],
      });
      engine.flush(data.conversation.id);
      await failed.promise;
      assert.equal(data.store.conversation(data.conversation.id)!.processedSequence, 0);
      assert.match(data.store.conversation(data.conversation.id)!.error, /HTTP 429/);
      assert.equal(data.store.imageCache.size(), 0);
      assert.equal(ai.calls.length, 0);
      retry = true;
      engine.flush(data.conversation.id);
      await completed.promise;
      assert.ok(data.store.imageCache.size() > 0);
      assert.equal(ai.calls.filter((call) => call === prompts.summary).length, 1);
    } finally {
      images.stop();
      await engine.stop();
      data.cleanup();
    }
  },
);

for (const target of ['contact', 'conversation'] as const) {
  test(
    `暂停 ${target} 中止首次图片请求，供应商迟到回传不写缓存或摘要`,
    { timeout: 5000 },
    async () => {
      const data = fixture();
      const bytes = await png();
      const started = deferred<AbortSignal>(),
        response = deferred<typeof result>();
      const images = new ImageAnalysisService({
        cache: data.store.imageCache,
        configuration: () => ({ account: '10001', model: 'invalid-test-model' }),
        resolveImage: async (image) => image.url!,
        download: async () => bytes,
        analyzeImage: async (_image, signal) => {
          started.resolve(signal);
          return response.promise;
        },
      });
      const ai = new FakeAi(() => summary);
      const engine = new AnalysisEngine(data.store, ai, () => {}, images);
      try {
        data.store.addMessage({
          ...data.message('one'),
          segments: [{ type: 'image', url: 'https://gchat.qpic.cn/one' }],
        });
        engine.flush(data.conversation.id);
        const signal = await started.promise;
        if (target === 'contact') data.store.saveContact({ ...data.contact, paused: true });
        else
          data.store.saveConversation({
            ...data.store.conversation(data.conversation.id)!,
            paused: true,
          });
        engine.cancel(data.conversation.id);
        assert.equal(signal.aborted, true);
        response.resolve(result);
        await engine.stop();
        assert.equal(data.store.imageCache.size(), 0);
        assert.equal(data.store.conversation(data.conversation.id)!.processedSequence, 0);
        assert.equal(ai.calls.length, 0);
      } finally {
        response.resolve(result);
        images.stop();
        await engine.stop();
        data.cleanup();
      }
    },
  );
}

test(
  '新消息取消首次图片分析，迟到结果不写缓存，重算时从有效进度重新分析',
  { timeout: 5000 },
  async () => {
    const data = fixture();
    const bytes = await png();
    const started = deferred<AbortSignal>(),
      oldResponse = deferred<typeof result>(),
      completed = deferred<void>();
    let attempts = 0;
    const images = new ImageAnalysisService({
      cache: data.store.imageCache,
      configuration: () => ({ account: '10001', model: 'invalid-test-model' }),
      resolveImage: async (image) => image.url!,
      download: async () => bytes,
      analyzeImage: async (_image, signal) => {
        if (++attempts === 1) {
          started.resolve(signal);
          return oldResponse.promise;
        }
        return result;
      },
    });
    const ai = new FakeAi((instruction) =>
      instruction === prompts.summary
        ? summary
        : instruction === prompts.gate
          ? { needed: false, reason: '无需建议', keywords: [] }
          : { traits: {}, traitSourceIds: {}, memories: [] },
    );
    const engine = new AnalysisEngine(
      data.store,
      ai,
      () => {
        if ((data.store.conversation(data.conversation.id)?.consolidatedSequence ?? 0) >= 2)
          completed.resolve();
      },
      images,
    );
    try {
      data.store.addMessage({
        ...data.message('one'),
        segments: [{ type: 'image', url: 'https://gchat.qpic.cn/one' }],
      });
      engine.flush(data.conversation.id);
      const oldSignal = await started.promise;
      data.store.addMessage(data.message('two', '补充确认时间'));
      engine.notify(data.conversation.id);
      assert.equal(oldSignal.aborted, true);
      engine.flush(data.conversation.id);
      oldResponse.resolve({ description: '过期的图片结果', limitations: '' });
      await completed.promise;
      assert.equal(attempts, 2);
      assert.equal(data.store.observations(data.conversation.id).length, 1);
      assert.equal(ai.calls.filter((call) => call === prompts.summary).length, 1);
      const digest = data.store.memories(data.contact.id)[0]?.imageEvidence?.[0]?.analysis.sha256;
      assert.equal(digest, undefined);
      const prepared = await images.prepareContext(
        {
          messages: [
            {
              ...data.message('one'),
              segments: [{ type: 'image', url: 'https://gchat.qpic.cn/one' }],
            },
          ],
        },
        new AbortController().signal,
      );
      assert.equal(prepared.imageEvidence[0]?.analysis.description, result.description);
      assert.equal(attempts, 2);
    } finally {
      oldResponse.resolve(result);
      images.stop();
      await engine.stop();
      data.cleanup();
    }
  },
);
