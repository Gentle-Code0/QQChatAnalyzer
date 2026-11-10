import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { z } from 'zod';
import sharp from 'sharp';
import { prepareImage } from '../server/images.js';
import { ImageAnalysisService } from '../server/image-analysis.js';
import { fixture } from './helpers.js';
import { CompatibleAi, prompts } from '../server/ai.js';
import type { ProgressEvent } from '../server/progress.js';
import { settingsSchema, messageSchema } from '../shared/schema.js';

test('旧式图片 URL 被拒绝时，内嵌图片让各阶段按原顺序成功调用同一模型', async () => {
  const requests: unknown[] = [];
  let legacyRejected = 0;
  const firstImage = await sharp({
    create: { width: 2, height: 2, channels: 4, background: 'red' },
  })
    .png()
    .toBuffer();
  const secondImage = await sharp({
    create: { width: 2, height: 2, channels: 4, background: 'blue' },
  })
    .png()
    .toBuffer();
  const embedded = new Map<string, string>();
  const progress: ProgressEvent[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (JSON.stringify(body).includes('https://example.invalid/')) {
      legacyRejected++;
      response.writeHead(400, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ code: 20015, message: 'Failed to download image from URL' }));
      return;
    }
    requests.push(body);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }));
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const settings = settingsSchema.parse({
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    model: 'test-multimodal-model',
  });
  const ai = new CompatibleAi(
    () => ({ settings, apiKey: 'invalid-test-key' }),
    undefined,
    async (url, signal, report) => {
      const prepared = await prepareImage(url, signal, report, async () =>
        url.endsWith('/first.png') ? firstImage : secondImage,
      );
      embedded.set(url, prepared.dataUrl);
      return prepared;
    },
  );
  try {
    const legacy = await fetch(`${settings.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: settings.model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: 'https://example.invalid/first.png' } },
            ],
          },
        ],
      }),
    });
    assert.equal(legacy.status, 400);
    await legacy.body?.cancel();
    for (const instruction of Object.values(prompts)) {
      const result = await ai.call(
        instruction,
        {
          messages: [
            messageSchema.parse({
              id: 'image-message',
              conversationId: 'test',
              senderId: '12345',
              senderName: '测试对象',
              time: 1,
              source: 'live',
              text: '前文[图片]中间[图片]后文',
              segments: [
                { type: 'text', text: '前文' },
                { type: 'image', url: 'https://example.invalid/first.png' },
                { type: 'text', text: '中间' },
                { type: 'image', url: 'https://example.invalid/second.png' },
                { type: 'text', text: '后文' },
              ],
            }),
          ],
        },
        z.object({ ok: z.boolean() }),
        new AbortController().signal,
        (event) => progress.push(event),
      );
      assert.equal(result.ok, true);
    }
    await assert.rejects(
      ai.call(
        prompts.summary,
        {
          messages: [
            messageSchema.parse({
              id: 'invalid-image',
              conversationId: 'test',
              senderId: '12345',
              senderName: '测试对象',
              time: 1,
              source: 'live',
              text: '[图片]',
              segments: [{ type: 'image', url: 'file:///invalid-test-image' }],
            }),
          ],
        },
        z.object({ ok: z.boolean() }),
        new AbortController().signal,
      ),
      /HTTP\(S\)/,
    );
    assert.equal(legacyRejected, 1);
    assert.equal(requests.length, 4);
    for (const label of [
      '校验 AI 配置',
      '组织图文上下文',
      '读取消息图片地址',
      '调用模型 · 等待服务响应',
      '读取 AI 回传',
      '解析兼容协议回传',
      '校验模型输出字段',
    ]) {
      assert.ok(progress.some((event) => event.label === label && event.status === 'running'));
      assert.ok(progress.some((event) => event.label === label && event.status === 'completed'));
    }
    assert.equal(JSON.stringify(progress).includes('example.invalid'), false);
    assert.equal(JSON.stringify(progress).includes('invalid-test-key'), false);
    assert.ok([...embedded.values()].every((url) => url.startsWith('data:image/png;base64,')));
    for (const request of requests) {
      const parsed = z
        .object({
          model: z.string(),
          messages: z.array(
            z.object({
              role: z.string(),
              content: z.union([
                z.string(),
                z.array(
                  z.discriminatedUnion('type', [
                    z.object({ type: z.literal('text'), text: z.string() }),
                    z.object({
                      type: z.literal('image_url'),
                      image_url: z.object({ url: z.string() }),
                    }),
                  ]),
                ),
              ]),
            }),
          ),
        })
        .parse(request);
      assert.equal(parsed.model, settings.model);
      const content = parsed.messages.find((message) => message.role === 'user')?.content;
      assert.ok(Array.isArray(content));
      assert.deepEqual(
        content
          .slice(2, -1)
          .map((part) => (part.type === 'image_url' ? part.image_url.url : JSON.parse(part.text))),
        [
          { segment: 1, type: 'text', text: '前文' },
          { segment: 2, type: 'image' },
          embedded.get('https://example.invalid/first.png'),
          { segment: 3, type: 'text', text: '中间' },
          { segment: 4, type: 'image' },
          embedded.get('https://example.invalid/second.png'),
          { segment: 5, type: 'text', text: '后文' },
        ],
      );
    }
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
});

test(
  '独立图片分析仅首次传图，聊天上下文只包含带位置的文字分析，重复发送无需第二次视觉请求',
  { timeout: 5000 },
  async () => {
    const data = fixture();
    const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } })
      .png()
      .toBuffer();
    const requests: { visual: boolean; content: string }[] = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const input = z
        .object({
          messages: z.array(
            z.object({
              content: z.union([z.string(), z.array(z.object({ type: z.string() }).passthrough())]),
            }),
          ),
        })
        .parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      const content = JSON.stringify(input.messages.at(-1)?.content);
      const visual = content.includes('"type":"image_url"');
      requests.push({ visual, content });
      response.setHeader('Content-Type', 'application/json');
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify(
                  visual
                    ? { description: '红色测试图', limitations: '只描述图片本身' }
                    : { ok: true },
                ),
              },
            },
          ],
        }),
      );
    }).listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const settings = settingsSchema.parse({
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      model: 'invalid-test-model',
    });
    const ai = new CompatibleAi(() => ({ settings, apiKey: 'invalid-test-key' }));
    const images = new ImageAnalysisService({
      cache: data.store.imageCache,
      configuration: () => ({ account: '10001', model: settings.model }),
      resolveImage: async (image) => image.url!,
      download: async () => bytes,
      analyzeImage: (image, signal, report) => ai.analyzeImage(image, signal, report),
    });
    try {
      for (const id of ['one', 'two']) {
        const prepared = await images.prepareContext(
          {
            messages: [
              {
                ...data.message(id),
                segments: [
                  { type: 'text', text: `第${id}次发送` },
                  { type: 'image', file: id, url: `https://gchat.qpic.cn/${id}` },
                ],
              },
            ],
          },
          new AbortController().signal,
        );
        await ai.call(
          '仅返回 {ok:true}',
          prepared.context,
          z.object({ ok: z.literal(true) }),
          new AbortController().signal,
        );
      }
      assert.equal(requests.length, 3);
      assert.deepEqual(
        requests.map((item) => item.visual),
        [true, false, false],
      );
      assert.ok(requests[0]?.content.includes('data:image/'));
      assert.ok(!requests[0]?.content.includes('senderId'));
      assert.ok(
        requests
          .slice(1)
          .every(
            (item) =>
              item.content.includes('红色测试图') &&
              item.content.includes('senderId') &&
              item.content.includes('endMessage'),
          ),
      );
      assert.ok(requests[2]?.content.includes('第two次发送'));
    } finally {
      images.stop();
      data.cleanup();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);
