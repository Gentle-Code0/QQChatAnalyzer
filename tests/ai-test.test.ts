import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { z } from 'zod';
import { Application } from '../server/application.js';
import { createApi } from '../server/http.js';
import { AiCallError, CompatibleAi, consolidationSchema } from '../server/ai.js';
import { aiTestResultSchema } from '../shared/schema.js';
import { fixture, deferred } from './helpers.js';

async function close(server: Server) {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}
function address(server: Server): string {
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

test(
  '测试 API 受认证和同源保护，使用未保存配置且不泄露密钥或保存测试结果',
  { timeout: 10000 },
  async () => {
    const data = fixture();
    const application = new Application(data.store);
    data.store.setSecret('apiKey', 'invalid-saved-test-key');
    const settingsBefore = data.store.settings;
    const contactBefore = data.store.contact(data.contact.id);
    const conversationBefore = data.store.conversation(data.conversation.id);
    let mode = 'success';
    let requests = 0;
    let expectedKey = 'invalid-draft-test-key';
    let expectedModel = 'draft-model';
    const provider = createServer(async (request, response) => {
      requests++;
      assert.equal(request.url, '/v1/chat/completions');
      assert.equal(request.headers.authorization, `Bearer ${expectedKey}`);
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = z
        .object({
          model: z.string(),
          messages: z.array(z.object({ role: z.string(), content: z.string() })),
        })
        .parse(JSON.parse(Buffer.concat(chunks).toString()));
      assert.equal(body.model, expectedModel);
      assert.equal(
        body.messages.find((message) => message.role === 'user')?.content,
        '{"connectionTest":true}',
      );
      response.setHeader('Content-Type', 'application/json');
      if (mode === 'http') {
        response.writeHead(401);
        response.end('invalid-saved-test-key');
        return;
      }
      if (mode === 'json') {
        response.end('not JSON invalid-saved-test-key');
        return;
      }
      if (mode === 'envelope') {
        response.end('{"choices":[]}');
        return;
      }
      const content =
        mode === 'output-json'
          ? 'not JSON invalid-saved-test-key'
          : mode === 'output-schema'
            ? '{"ok":false}'
            : '{"ok":true}';
      response.end(JSON.stringify({ choices: [{ message: { content } }] }));
    }).listen(0, '127.0.0.1');
    const api = createApi(application, 'invalid-test-password').listen(0, '127.0.0.1');
    await Promise.all([once(provider, 'listening'), once(api, 'listening')]);
    const endpoint = `${address(api)}/api/settings/ai/test`;
    const input = { baseUrl: `${address(provider)}/v1`, model: expectedModel, apiKey: expectedKey };
    try {
      assert.equal((await fetch(endpoint, { method: 'POST' })).status, 401);
      const login = await fetch(`${address(api)}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'invalid-test-password' }),
      });
      const cookie = login.headers.get('set-cookie')?.split(';')[0];
      assert.ok(cookie);
      const headers = { Cookie: cookie, 'Content-Type': 'application/json' };
      assert.equal(
        (
          await fetch(endpoint, {
            method: 'POST',
            headers: { ...headers, Origin: 'https://evil.invalid' },
            body: JSON.stringify(input),
          })
        ).status,
        403,
      );
      assert.equal(requests, 0);
      async function check(value: unknown) {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(value),
        });
        assert.equal(response.status, 200);
        const text = await response.text();
        assert.equal(text.includes('invalid-saved-test-key'), false);
        assert.equal(text.includes('invalid-draft-test-key'), false);
        return aiTestResultSchema.parse(JSON.parse(text));
      }
      assert.equal((await check(input)).ok, true);
      expectedKey = 'invalid-saved-test-key';
      expectedModel = 'another-draft-model';
      assert.equal((await check({ ...input, model: expectedModel, apiKey: '' })).ok, true);
      for (const [failure, step] of [
        ['http', 'HTTP 响应'],
        ['json', '解析回传'],
        ['envelope', '解析回传'],
        ['output-json', '校验模型输出'],
        ['output-schema', '校验模型输出'],
      ]) {
        mode = failure ?? '';
        const result = await check({ ...input, model: expectedModel, apiKey: '' });
        assert.equal(result.ok, false);
        assert.ok(!result.ok);
        assert.equal(result.step, step);
        if (failure === 'http') assert.match(result.message, /401/);
      }
      assert.equal(data.store.secret('apiKey'), 'invalid-saved-test-key');
      const beforeInvalid = requests;
      for (const invalid of [
        { ...input, baseUrl: 'file:///invalid' },
        { ...input, baseUrl: 'https://user:secret@example.invalid' },
        { ...input, model: '' },
      ]) {
        const result = await check(invalid);
        assert.ok(!result.ok);
        assert.equal(result.step, '配置校验');
      }
      data.store.setSecret('apiKey', '');
      const missing = await check({ ...input, apiKey: '' });
      assert.ok(!missing.ok);
      assert.equal(missing.step, '配置校验');
      assert.equal(requests, beforeInvalid);
      assert.deepEqual(data.store.settings, settingsBefore);
      assert.deepEqual(data.store.contact(data.contact.id), contactBefore);
      assert.deepEqual(data.store.conversation(data.conversation.id), conversationBefore);
      assert.equal(data.store.secret('apiKey'), '');
      assert.equal(data.store.decisions(data.conversation.id).length, 0);
    } finally {
      await close(api);
      await close(provider);
      await application.stop();
      data.cleanup();
    }
  },
);

test('连接失败、读取失败、空回传和超限回传均报告对应步骤', async (context) => {
  const data = fixture();
  const application = new Application(data.store);
  const input = {
    baseUrl: 'https://example.invalid/v1',
    model: 'test-model',
    apiKey: 'invalid-test-key',
  };
  try {
    const fetchMock = context.mock.method(globalThis, 'fetch', async (): Promise<Response> => {
      throw new Error('private-provider-detail');
    });
    const network = await application.testAi(input, new AbortController().signal);
    assert.ok(!network.ok);
    assert.equal(network.step, '发送请求');
    assert.equal(network.message.includes('private-provider-detail'), false);
    fetchMock.mock.mockImplementation(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error('private-provider-detail'));
            },
          }),
        ),
    );
    const read = await application.testAi(input, new AbortController().signal);
    assert.ok(!read.ok);
    assert.equal(read.step, '读取回传');
    assert.equal(read.message.includes('private-provider-detail'), false);
    for (const body of ['', 'x'.repeat(2 * 1024 * 1024 + 1)]) {
      fetchMock.mock.mockImplementation(async () => new Response(body));
      const result = await application.testAi(input, new AbortController().signal);
      assert.ok(!result.ok);
      assert.equal(result.step, '读取回传');
    }
  } finally {
    await application.stop();
    data.cleanup();
  }
});

test('测试超时报告发生步骤，使用信号模拟而不等待真实超时', async (context) => {
  const data = fixture();
  const application = new Application(data.store);
  const timeout = new AbortController();
  context.mock.method(AbortSignal, 'timeout', () => timeout.signal);
  context.mock.method(globalThis, 'fetch', async (): Promise<Response> => {
    timeout.abort(new DOMException('test timeout', 'TimeoutError'));
    throw new Error('test timeout');
  });
  try {
    const result = await application.testAi(
      { baseUrl: 'https://example.invalid', model: 'test', apiKey: 'invalid-test-key' },
      new AbortController().signal,
    );
    assert.ok(!result.ok);
    assert.equal(result.step, '发送请求');
    assert.match(result.message, /45 秒/);
  } finally {
    await application.stop();
    data.cleanup();
  }
});

for (const action of ['cancel', 'shutdown'] as const) {
  test(`${action} 终止在途测试且不允许重复测试`, { timeout: 5000 }, async (context) => {
    const data = fixture();
    const application = new Application(data.store);
    const started = deferred<AbortSignal>();
    context.mock.method(
      globalThis,
      'fetch',
      async (_url: unknown, options?: RequestInit): Promise<Response> => {
        const signal = options?.signal;
        assert.ok(signal);
        started.resolve(signal);
        return new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }),
        );
      },
    );
    const controller = new AbortController();
    const input = { baseUrl: 'https://example.invalid', model: 'test', apiKey: 'invalid-test-key' };
    try {
      const running = application.testAi(input, controller.signal);
      const signal = await started.promise;
      assert.equal((await application.testAi(input, new AbortController().signal)).ok, false);
      if (action === 'cancel') controller.abort();
      else await application.stop();
      const result = await running;
      assert.equal(signal.aborted, true);
      assert.ok(!result.ok);
      assert.match(result.message, /取消/);
    } finally {
      controller.abort();
      await application.stop();
      data.cleanup();
    }
  });
}

test('页面断开时取消后端在途测试', { timeout: 5000 }, async () => {
  const data = fixture();
  const application = new Application(data.store);
  const started = deferred<void>();
  const disconnected = deferred<void>();
  const provider = createServer((request, response) => {
    request.resume();
    response.once('close', () => disconnected.resolve());
    started.resolve();
  }).listen(0, '127.0.0.1');
  const api = createApi(application, 'invalid-test-password').listen(0, '127.0.0.1');
  await Promise.all([once(provider, 'listening'), once(api, 'listening')]);
  const controller = new AbortController();
  try {
    const login = await fetch(`${address(api)}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'invalid-test-password' }),
    });
    const cookie = login.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie);
    const pending = fetch(`${address(api)}/api/settings/ai/test`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        baseUrl: address(provider),
        model: 'test',
        apiKey: 'invalid-test-key',
      }),
      signal: controller.signal,
    });
    await started.promise;
    const rejected = assert.rejects(pending, { name: 'AbortError' });
    controller.abort();
    await rejected;
    await disconnected.promise;
    assert.equal(data.store.decisions(data.conversation.id).length, 0);
  } finally {
    controller.abort();
    await close(api);
    await application.stop();
    await close(provider);
    data.cleanup();
  }
});

test('复杂归纳输出不合格时显示字段路径，隐藏收到的字段值', async (context) => {
  const data = fixture();
  context.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  traits: { likes: 'invalid-private-test-detail'.repeat(200) },
                  memories: [],
                }),
              },
            },
          ],
        }),
      ),
  );
  const ai = new CompatibleAi(() => ({
    settings: data.store.settings,
    apiKey: 'invalid-test-key',
  }));
  try {
    await assert.rejects(
      ai.call('test', {}, consolidationSchema, new AbortController().signal),
      (error: unknown) => {
        assert.ok(error instanceof AiCallError);
        assert.equal(error.step, '校验模型输出');
        assert.match(error.message, /traitSourceIds/);
        assert.match(error.message, /traits.likes/);
        assert.equal(error.message.includes('invalid-private-test-detail'), false);
        return true;
      },
    );
  } finally {
    data.cleanup();
  }
});
