import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { z } from 'zod';
import sharp from 'sharp';
import { prepareImage } from '../server/images.js';
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
