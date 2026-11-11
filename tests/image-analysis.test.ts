import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { ImageAnalysisService } from '../server/image-analysis.js';
import { buildContextContent, contextSchema } from '../server/ai-context.js';
import { imageCachePolicy } from '../server/image-cache.js';
import { Store } from '../server/store.js';
import { fixture, deferred } from './helpers.js';
import { messageSchema } from '../shared/schema.js';

const result = {
  description: '红色测试图，文字不可辨识',
  limitations: '仅依据图片本身，不推断发送意图',
};
const signal = () => new AbortController().signal;
function context(id: string, file = 'same-file', senderId = '12345', time = 1) {
  return {
    kind: 'private',
    messages: [
      {
        ...messageSchema.parse({
          id,
          conversationId: 'conversation',
          senderId,
          senderName: '测试发送者',
          time,
          source: 'live',
          text: '前文[图片]后文',
          segments: [
            { type: 'text', text: '前文' },
            { type: 'image', file, url: `https://gchat.qpic.cn/${file}` },
            { type: 'text', text: '后文' },
          ],
        }),
        senderRole: senderId === '12345' ? 'contact' : 'self',
      },
    ],
  };
}
async function png(color: string) {
  return sharp({ create: { width: 2, height: 2, channels: 3, background: color } })
    .png()
    .toBuffer();
}

test('不同 QQ 标识的相同完整文件只分析一次，每个新消息都 SHA 核验，原消息复用不再下载', async () => {
  const data = fixture();
  const bytes = await png('red');
  let downloads = 0,
    analyses = 0;
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
  try {
    const first = await images.prepareContext(context('one', 'file-a'), signal());
    const second = await images.prepareContext(context('two', 'file-b', '10001', 200), signal());
    await images.prepareContext(context('one', 'file-a'), signal());
    assert.equal(downloads, 2);
    assert.equal(analyses, 1);
    assert.equal(
      first.imageEvidence[0]?.analysis.sha256,
      createHash('sha256').update(bytes).digest('hex'),
    );
    assert.equal(second.imageEvidence[0]?.senderId, '10001');
    assert.equal(second.imageEvidence[0]?.time, 200);
    assert.equal(second.imageEvidence[0]?.segmentIndex, 1);
    const content = await buildContextContent(
      second.context,
      async () => {
        throw new Error('不应再次取图');
      },
      signal(),
    );
    assert.ok(Array.isArray(content));
    assert.equal(
      content.some((part) => part.type === 'image_url'),
      false,
    );
    const text = content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n');
    assert.ok(text.indexOf('前文') < text.indexOf(result.description));
    assert.ok(text.indexOf(result.description) < text.indexOf('后文'));
    assert.match(text, /"senderId":"10001"/);
    assert.match(text, /"time":200/);
    assert.match(text, /"segment":2/);
    assert.equal(contextSchema.parse(first.context).messages?.[0]?.segments?.length, 3);
  } finally {
    images.stop();
    data.cleanup();
  }
});

test('相同 QQ 标识但文件不同必须重新分析，原消息仍关联原先指纹', async () => {
  const data = fixture();
  let bytes = await png('red');
  let analyses = 0;
  const images = new ImageAnalysisService({
    cache: data.store.imageCache,
    configuration: () => ({ account: '10001', model: 'invalid-test-model' }),
    resolveImage: async (image) => image.url!,
    download: async () => bytes,
    analyzeImage: async () => {
      analyses++;
      return result;
    },
  });
  try {
    const first = await images.prepareContext(context('one'), signal());
    bytes = await png('blue');
    const second = await images.prepareContext(context('two'), signal());
    const original = await images.prepareContext(context('one'), signal());
    assert.equal(analyses, 2);
    assert.notEqual(
      first.imageEvidence[0]?.analysis.sha256,
      second.imageEvidence[0]?.analysis.sha256,
    );
    assert.equal(
      first.imageEvidence[0]?.analysis.sha256,
      original.imageEvidence[0]?.analysis.sha256,
    );
  } finally {
    images.stop();
    data.cleanup();
  }
});

test('动图完整文件不同而首帧相同时不误合并，分析结果保留首帧限制', async () => {
  const data = fixture();
  const gif = async (blue: boolean) =>
    sharp(
      Buffer.from([
        255,
        0,
        0,
        255,
        255,
        0,
        0,
        255,
        ...(blue ? [0, 0, 255, 255, 0, 0, 255, 255] : [0, 255, 0, 255, 0, 255, 0, 255]),
      ]),
      { raw: { width: 2, height: 2, channels: 4, pageHeight: 1 } },
    )
      .gif({ delay: [100, 100], loop: 0 })
      .toBuffer();
  let bytes = await gif(true);
  const normalized: string[] = [];
  const images = new ImageAnalysisService({
    cache: data.store.imageCache,
    configuration: () => ({ account: '10001', model: 'invalid-test-model' }),
    resolveImage: async (image) => image.url!,
    download: async () => bytes,
    analyzeImage: async (image) => {
      normalized.push(image.dataUrl);
      return result;
    },
  });
  try {
    const first = await images.prepareContext(context('one'), signal());
    bytes = await gif(false);
    const second = await images.prepareContext(context('two'), signal());
    assert.equal(normalized.length, 2);
    assert.equal(normalized[0], normalized[1]);
    assert.notEqual(
      first.imageEvidence[0]?.analysis.sha256,
      second.imageEvidence[0]?.analysis.sha256,
    );
    assert.equal(first.imageEvidence[0]?.analysis.scope, 'first-frame');
  } finally {
    images.stop();
    data.cleanup();
  }
});

test('服务重建及数据库重启后原消息可离线复用；新账号不能命中旧账号结果', async () => {
  const data = fixture();
  const bytes = await png('red');
  const images = new ImageAnalysisService({
    cache: data.store.imageCache,
    configuration: () => ({ account: '10001', model: 'invalid-test-model' }),
    resolveImage: async (image) => image.url!,
    download: async () => bytes,
    analyzeImage: async () => result,
  });
  let reopened: Store | undefined;
  try {
    await images.prepareContext(context('one'), signal());
    images.stop();
    reopened = new Store(data.directory);
    const offline = new ImageAnalysisService({
      cache: reopened.imageCache,
      configuration: () => ({ account: '10001', model: 'invalid-test-model' }),
      resolveImage: async () => {
        throw new Error('测试离线');
      },
      analyzeImage: async () => {
        throw new Error('不应调用');
      },
    });
    try {
      assert.equal(
        (await offline.prepareContext(context('one'), signal())).imageEvidence[0]?.analysis
          .description,
        result.description,
      );
    } finally {
      offline.stop();
    }
    const other = new ImageAnalysisService({
      cache: reopened.imageCache,
      configuration: () => ({ account: '20002', model: 'invalid-test-model' }),
      resolveImage: async () => {
        throw new Error('测试离线');
      },
      analyzeImage: async () => result,
    });
    try {
      const unavailable = await other.prepareContext(context('one'), signal());
      assert.equal(unavailable.imageEvidence.length, 0);
      assert.match(JSON.stringify(unavailable.context), /图片无法下载/);
    } finally {
      other.stop();
    }
  } finally {
    images.stop();
    reopened?.close();
    data.cleanup();
  }
});

test('并发同图只有一个视觉请求，取消等待者不取消其他会话', async () => {
  const data = fixture();
  const bytes = await png('red');
  const started = deferred<AbortSignal>();
  const response = deferred<typeof result>();
  const bothDownloaded = deferred<void>();
  let downloads = 0,
    analyses = 0;
  const images = new ImageAnalysisService({
    cache: data.store.imageCache,
    configuration: () => ({ account: '10001', model: 'invalid-test-model' }),
    resolveImage: async (image) => image.url!,
    download: async () => {
      if (++downloads === 2) bothDownloaded.resolve();
      return bytes;
    },
    analyzeImage: async (_image, requestSignal) => {
      analyses++;
      started.resolve(requestSignal);
      return response.promise;
    },
  });
  const waiter = new AbortController();
  try {
    const first = images.prepareContext(context('one'), signal());
    const firstSignal = await started.promise;
    const second = images.prepareContext(context('two'), waiter.signal);
    const rejection = assert.rejects(second, { name: 'AbortError' });
    await bothDownloaded.promise;
    waiter.abort();
    await rejection;
    assert.equal(firstSignal.aborted, false);
    response.resolve(result);
    await first;
    assert.equal(analyses, 1);
    await images.prepareContext(context('two'), signal());
    assert.equal(analyses, 1);
  } finally {
    response.resolve(result);
    images.stop();
    data.cleanup();
  }
});

test('取消首次视觉请求后即使供应商仍回传也不缓存；失败分析允许重新调用', async () => {
  const data = fixture();
  const bytes = await png('red');
  const started = deferred<AbortSignal>();
  const response = deferred<typeof result>();
  let attempt = 0;
  const images = new ImageAnalysisService({
    cache: data.store.imageCache,
    configuration: () => ({ account: '10001', model: 'invalid-test-model' }),
    resolveImage: async (image) => image.url!,
    download: async () => bytes,
    analyzeImage: async (_image, requestSignal) => {
      attempt++;
      if (attempt === 1) {
        started.resolve(requestSignal);
        return response.promise;
      }
      return result;
    },
  });
  try {
    const controller = new AbortController();
    const first = images.prepareContext(context('one'), controller.signal);
    await started.promise;
    controller.abort();
    response.resolve(result);
    await assert.rejects(first, { name: 'AbortError' });
    assert.equal(data.store.imageCache.size(), 0);
    await images.prepareContext(context('one'), signal());
    assert.equal(attempt, 2);
  } finally {
    response.resolve(result);
    images.stop();
    data.cleanup();
  }
});

test('30 天自动清理不依赖新消息，关闭后不再运行清理计时器', (context) => {
  context.mock.timers.enable({ apis: ['setInterval'] });
  const data = fixture();
  let now = 0,
    runs = 0;
  const prune = data.store.imageCache.prune.bind(data.store.imageCache);
  context.mock.method(data.store.imageCache, 'prune', (time: number) => {
    runs++;
    prune(time);
  });
  const images = new ImageAnalysisService({
    cache: data.store.imageCache,
    configuration: () => ({ account: '10001', model: 'invalid-test-model' }),
    resolveImage: async (image) => image.url!,
    analyzeImage: async () => result,
    now: () => now,
  });
  try {
    data.store.imageCache.save(
      '10001',
      { ...result, sha256: 'a'.repeat(64), scope: 'static', model: 'invalid-test-model' },
      0,
      'occurrence',
      'alias',
    );
    images.start();
    const initialRuns = runs;
    now = imageCachePolicy.maxIdleMs;
    context.mock.timers.tick(imageCachePolicy.cleanupIntervalMs);
    assert.equal(data.store.imageCache.size(), 0);
    assert.equal(runs, initialRuns + 1);
    images.stop();
    context.mock.timers.tick(imageCachePolicy.cleanupIntervalMs);
    assert.equal(runs, initialRuns + 1);
  } finally {
    images.stop();
    context.mock.timers.reset();
    data.cleanup();
  }
});

test('等待同图的会话在首个请求失败后可独立重试，并共享后续成功结果', async () => {
  const data = fixture();
  const bytes = await png('red');
  const started = deferred<void>(),
    failFirst = deferred<void>(),
    bothDownloaded = deferred<void>();
  let downloads = 0,
    attempts = 0;
  const images = new ImageAnalysisService({
    cache: data.store.imageCache,
    configuration: () => ({ account: '10001', model: 'invalid-test-model' }),
    resolveImage: async (image) => image.url!,
    download: async () => {
      if (++downloads === 2) bothDownloaded.resolve();
      return bytes;
    },
    analyzeImage: async () => {
      if (++attempts === 1) {
        started.resolve();
        await failFirst.promise;
        throw new Error('测试失败');
      }
      return result;
    },
  });
  try {
    const first = images.prepareContext(context('one'), signal());
    const rejected = assert.rejects(first, /测试失败/);
    await started.promise;
    const second = images.prepareContext(context('two'), signal());
    await bothDownloaded.promise;
    failFirst.resolve();
    await rejected;
    assert.equal((await second).imageEvidence[0]?.analysis.description, result.description);
    assert.equal(attempts, 2);
  } finally {
    failFirst.resolve();
    images.stop();
    data.cleanup();
  }
});

test('定时清理失败可观察，服务停止后拒绝新图片分析', async (context) => {
  context.mock.timers.enable({ apis: ['setInterval'] });
  const data = fixture();
  let failures = 0;
  const images = new ImageAnalysisService({
    cache: data.store.imageCache,
    configuration: () => ({ account: '10001', model: 'invalid-test-model' }),
    resolveImage: async (image) => image.url!,
    analyzeImage: async () => result,
    cleanupFailed: () => {
      failures++;
    },
  });
  try {
    images.start();
    context.mock.method(data.store.imageCache, 'prune', () => {
      throw new Error('invalid-test-maintenance-failure');
    });
    context.mock.timers.tick(imageCachePolicy.cleanupIntervalMs);
    assert.equal(failures, 1);
    images.stop();
    await assert.rejects(images.prepareContext(contextSchema.parse({ messages: [] }), signal()), {
      name: 'AbortError',
    });
  } finally {
    images.stop();
    context.mock.timers.reset();
    data.cleanup();
  }
});

test('缓存到期后相同消息重新下载分析，不把过期结果作为已识别内容', async () => {
  const data = fixture();
  const bytes = await png('red');
  let now = 0,
    analyses = 0;
  const images = new ImageAnalysisService({
    cache: data.store.imageCache,
    configuration: () => ({ account: '10001', model: 'invalid-test-model' }),
    resolveImage: async (image) => image.url!,
    download: async () => bytes,
    now: () => now,
    analyzeImage: async () => {
      analyses++;
      return result;
    },
  });
  try {
    await images.prepareContext(context('one'), signal());
    now = imageCachePolicy.maxIdleMs;
    await images.prepareContext(context('one'), signal());
    assert.equal(analyses, 2);
  } finally {
    images.stop();
    data.cleanup();
  }
});

test('failed and oversized downloads become placeholders without restoration or model calls', async () => {
  const data = fixture();
  let modelCalls = 0;
  try {
    for (const mode of ['failed', 'oversized']) {
      const images = new ImageAnalysisService({
        cache: data.store.imageCache,
        configuration: () => ({ account: '10001', model: 'invalid-test-model' }),
        resolveImage: async (image) => image.url!,
        download: async () => {
          if (mode === 'failed') throw new Error('invalid test download');
          return Buffer.alloc(10 * 1024 * 1024 + 1);
        },
        analyzeImage: async () => {
          modelCalls++;
          return result;
        },
      });
      try {
        const prepared = await images.prepareContext(context(mode), signal());
        assert.equal(prepared.imageEvidence.length, 0);
        const parsed = contextSchema.parse(prepared.context);
        assert.deepEqual(parsed.messages?.[0]?.segments, [
          { type: 'text', text: '前文' },
          { type: 'text', text: '[图片无法下载或超限，未分析]' },
          { type: 'text', text: '后文' },
        ]);
      } finally {
        images.stop();
      }
    }
    assert.equal(modelCalls, 0);
    assert.equal(data.store.imageCache.size(), 0);
    assert.equal(imageCachePolicy.maxBytes, 200_000_000);
  } finally {
    data.cleanup();
  }
});
