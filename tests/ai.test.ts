import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { z } from 'zod';
import { CompatibleAi, prompts } from '../server/ai.js';
import { settingsSchema, messageSchema } from '../shared/schema.js';

test('各阶段均向同一模型发送有序的多图片上下文', async () => {
  const requests: unknown[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
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
  const ai = new CompatibleAi(() => ({ settings, apiKey: 'invalid-test-key' }));
  try {
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
    assert.equal(requests.length, 4);
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
          'https://example.invalid/first.png',
          { segment: 3, type: 'text', text: '中间' },
          { segment: 4, type: 'image' },
          'https://example.invalid/second.png',
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
