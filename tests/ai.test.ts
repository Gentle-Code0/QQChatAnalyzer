import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { z } from 'zod';
import { CompatibleAi, prompts } from '../server/ai.js';
import { settingsSchema } from '../shared/schema.js';

test('摘要、建议判断、详细建议与归纳均向配置的同一模型请求', async () => {
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
        { messages: [] },
        z.object({ ok: z.boolean() }),
        new AbortController().signal,
      );
      assert.equal(result.ok, true);
    }
    assert.equal(requests.length, 4);
    for (const request of requests) {
      assert.equal(z.object({ model: z.string() }).parse(request).model, settings.model);
    }
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
});
