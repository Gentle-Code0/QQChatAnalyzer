import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { z } from 'zod';
import { Application } from '../server/application.js';
import { QqBridge } from '../server/bridge.js';
import { AnalysisEngine } from '../server/engine.js';
import { AiCallError, prompts, type AiClient } from '../server/ai.js';
import { fixture, deferred } from './helpers.js';

const requestSchema = z.object({
  action: z.string(),
  params: z.record(z.unknown()),
  echo: z.string(),
});
const summary = {
  compressedPreviousSummary: '',
  summary: '对象确认周六见面',
  relevant: true,
  significant: false,
  attitude: 10,
  emotion: 5,
  mood: '平静',
  reason: '确认约定',
  adviceSignal: { worthChecking: true, reason: '历史不能触发新建议' },
};
class FakeAi implements AiClient {
  readonly calls: string[] = [];
  constructor(private readonly respond: (instruction: string) => unknown) {}
  async call<T>(instruction: string, _context: unknown, schema: z.ZodType<T>): Promise<T> {
    this.calls.push(instruction);
    return schema.parse(this.respond(instruction));
  }
}

test(
  'WebSocket 保持连接时，QQ 下线取消在途请求，上线重新验证账号并通知补读',
  { timeout: 5000 },
  async () => {
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const socketReady = deferred<import('ws').WebSocket>();
    const first = deferred<void>(),
      next = deferred<void>(),
      offline = deferred<void>(),
      requested = deferred<void>();
    let logins = 0,
      connections = 0;
    server.on('connection', (socket) => {
      socketReady.resolve(socket);
      socket.on('message', (bytes) => {
        const request = requestSchema.parse(JSON.parse(bytes.toString()));
        if (request.action === 'get_friend_msg_history') {
          requested.resolve();
          return;
        }
        if (request.action === 'get_login_info') logins++;
        socket.send(
          JSON.stringify({
            retcode: 0,
            echo: request.echo,
            data: request.action === 'get_login_info' ? { user_id: 10001 } : [],
          }),
        );
      });
    });
    const bridge = new QqBridge({
      url: `ws://127.0.0.1:${address.port}`,
      selfQq: '10001',
      token: '',
      onStatus: () => {},
      onMessage: () => {},
      onConnected: async () => {
        if (++connections === 1) first.resolve();
        else next.resolve();
      },
      onDisconnected: () => offline.resolve(),
    });
    try {
      bridge.start();
      await first.promise;
      const socket = await socketReady.promise;
      socket.send(
        JSON.stringify({
          post_type: 'notice',
          notice_type: 'bot_status',
          sub_type: 'offline',
          self_id: 20002,
          user_id: 20002,
        }),
      );
      await bridge.request('get_friend_list', {});
      assert.equal(bridge.connected, true);
      assert.equal(connections, 1);
      const pending = bridge.history('12345');
      const rejection = assert.rejects(pending, /离线/);
      await requested.promise;
      socket.send(
        JSON.stringify({
          post_type: 'notice',
          notice_type: 'bot_status',
          sub_type: 'offline',
          self_id: 10001,
          user_id: 10001,
        }),
      );
      await offline.promise;
      await rejection;
      assert.equal(bridge.connected, false);
      socket.send(
        JSON.stringify({
          post_type: 'notice',
          notice_type: 'bot_status',
          sub_type: 'online',
          self_id: 10001,
          user_id: 10001,
        }),
      );
      await next.promise;
      assert.equal(bridge.connected, true);
      assert.equal(logins, 2);
      assert.equal(connections, 2);
    } finally {
      bridge.stop();
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

test('群历史保留自身发言和负数锚点，错误账号或会话的历史页被拒绝', { timeout: 5000 }, async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const ready = deferred<void>();
  let invalid: 'none' | 'account' | 'peer' = 'none';
  server.on('connection', (socket) =>
    socket.on('message', (bytes) => {
      const request = requestSchema.parse(JSON.parse(bytes.toString()));
      let data: unknown = { user_id: 10001 };
      if (request.action === 'get_group_msg_history') {
        assert.equal(request.params.group_id, '22222');
        assert.equal(request.params.message_id, -123);
        assert.equal(request.params.reverse_order, true);
        data = {
          messages: [
            {
              message_type: 'group',
              self_id: invalid === 'account' ? 99999 : 10001,
              group_id: invalid === 'peer' ? 33333 : 22222,
              user_id: 10001,
              message_id: -456,
              time: 10,
              message: '自身历史发言',
            },
          ],
        };
      }
      socket.send(JSON.stringify({ retcode: 0, echo: request.echo, data }));
    }),
  );
  const bridge = new QqBridge({
    url: `ws://127.0.0.1:${address.port}`,
    selfQq: '10001',
    token: '',
    onStatus: () => {},
    onMessage: () => {},
    onConnected: async () => ready.resolve(),
  });
  try {
    bridge.start();
    await ready.promise;
    const page = await bridge.history('22222', -123, 'group');
    assert.equal(page.cursor, -456);
    assert.equal(page.messages[0]?.senderId, '10001');
    assert.equal(page.messages[0]?.peerId, '22222');
    invalid = 'account';
    await assert.rejects(bridge.history('22222', -123, 'group'), /身份不匹配/);
    invalid = 'peer';
    await assert.rejects(bridge.history('22222', -123, 'group'), /身份不匹配/);
  } finally {
    bridge.stop();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test(
  '应用启动和 WebSocket 自动重连均补回缺口，无需手动导入',
  { timeout: 5000 },
  async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const data = fixture();
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    data.store.settings = {
      ...data.store.settings,
      selfQq: '10001',
      qqUrl: `ws://127.0.0.1:${address.port}`,
    };
    const app = new Application(data.store),
      id = `${data.contact.id}:private:${data.contact.qq}`;
    app.receive(
      {
        id: '-1',
        kind: 'private',
        peerId: data.contact.qq,
        senderId: data.contact.qq,
        senderName: '测试对象',
        text: '旧记录',
        time: 1000,
        mentionedSelf: false,
      },
      'history',
    );
    let generation = 0,
      completions = 0;
    const first = deferred<void>(),
      second = deferred<void>(),
      offline = deferred<void>();
    const connected = app.history.connected.bind(app.history),
      disconnected = app.history.disconnected.bind(app.history);
    context.mock.method(app.history, 'connected', async () => {
      await connected();
      if (++completions === 1) first.resolve();
      else second.resolve();
    });
    context.mock.method(app.history, 'disconnected', () => {
      disconnected();
      offline.resolve();
    });
    server.on('connection', (socket) => {
      const generationNow = ++generation;
      socket.on('message', (bytes) => {
        const request = requestSchema.parse(JSON.parse(bytes.toString()));
        socket.send(
          JSON.stringify({
            retcode: 0,
            echo: request.echo,
            data:
              request.action === 'get_login_info'
                ? { user_id: 10001 }
                : {
                    messages: Array.from({ length: generationNow + 1 }, (_, index) => ({
                      message_type: 'private',
                      self_id: 10001,
                      user_id: index % 2 === 0 ? 12345 : 10001,
                      target_id: index % 2 === 0 ? 10001 : 12345,
                      message_id: -(index + 1),
                      time: index + 1,
                      message: `补读消息 ${index + 1}`,
                    })),
                  },
          }),
        );
      });
    });
    try {
      app.start();
      await first.promise;
      assert.equal(data.store.messageCount(id), 2);
      for (const socket of server.clients) socket.terminate();
      await offline.promise;
      context.mock.timers.tick(1000);
      await second.promise;
      assert.equal(data.store.messageCount(id), 3);
      assert.equal(data.store.historySync(id)?.recoveryPending, false);
      assert.match(data.store.conversation(id)!.historyStatus, /原消息锚点/);
    } finally {
      await app.stop();
      context.mock.timers.reset();
      data.cleanup();
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

for (const paused of [false, true]) {
  test(
    `少量历史补读自动更新摘要、画像和重要事件；暂停=${paused}`,
    { timeout: 5000 },
    async (context) => {
      context.mock.timers.enable({ apis: ['setTimeout'] });
      const data = fixture();
      data.store.settings = {
        ...data.store.settings,
        summaryMessageThreshold: 200,
        consolidationMessageThreshold: 1000,
      };
      const historical = { ...data.message('1'), source: 'history' as const };
      const done = deferred<void>();
      const ai = new FakeAi((instruction) =>
        instruction === prompts.summary
          ? summary
          : {
              traits: { communication: '表达直接' },
              traitSourceIds: { communication: ['1'] },
              memories: [
                {
                  subjectId: data.contact.qq,
                  kind: 'promise',
                  text: '对象确认周六见面',
                  time: 0,
                  sourceIds: ['1'],
                  keywords: ['见面'],
                },
              ],
            },
      );
      const engine = new AnalysisEngine(data.store, ai, () => {
        if (data.store.conversation(data.conversation.id)!.consolidatedSequence > 0) done.resolve();
      });
      try {
        data.store.addMessage(historical);
        if (paused) data.store.saveContact({ ...data.contact, paused: true });
        engine.historyImported(data.conversation.id);
        assert.ok(data.store.conversation(data.conversation.id)!.historyAnalysisSequence > 0);
        context.mock.timers.tick(60000);
        if (paused) {
          assert.deepEqual(ai.calls, []);
          data.store.saveContact({ ...data.contact, paused: false });
          engine.notify(data.conversation.id);
          context.mock.timers.tick(60000);
        }
        await done.promise;
        assert.deepEqual(ai.calls, [prompts.summary, prompts.consolidate]);
        assert.equal(data.store.decisions(data.conversation.id).length, 0);
        assert.equal(data.store.contact(data.contact.id)!.traits.communication, '表达直接');
        assert.equal(data.store.memories(data.contact.id)[0]?.time, historical.time);
        assert.deepEqual(data.store.memories(data.contact.id)[0]?.sourceIds, ['1']);
        assert.equal(data.store.conversation(data.conversation.id)!.processedSequence, 1);
      } finally {
        await engine.stop();
        context.mock.timers.reset();
        data.cleanup();
      }
    },
  );
}

test('补读归纳失败保留分析水位，重新调度只重试未完成阶段', { timeout: 5000 }, async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const data = fixture();
  const failed = deferred<void>(),
    done = deferred<void>();
  let retry = false;
  const ai = new FakeAi((instruction) => {
    if (instruction === prompts.summary) return summary;
    if (!retry) throw new AiCallError('HTTP 响应', 'AI 服务返回 HTTP 429。');
    return { traits: {}, traitSourceIds: {}, memories: [] };
  });
  const engine = new AnalysisEngine(data.store, ai, () => {
    const conversation = data.store.conversation(data.conversation.id)!;
    if (conversation.status === '分析失败') failed.resolve();
    if (conversation.consolidatedSequence > 0) done.resolve();
  });
  try {
    data.store.addMessage({ ...data.message('1'), source: 'history' });
    engine.historyImported(data.conversation.id);
    context.mock.timers.tick(60000);
    await failed.promise;
    assert.equal(data.store.conversation(data.conversation.id)!.processedSequence, 1);
    assert.equal(data.store.conversation(data.conversation.id)!.consolidatedSequence, 0);
    assert.equal(data.store.conversation(data.conversation.id)!.historyAnalysisSequence, 1);
    retry = true;
    engine.notify(data.conversation.id, false);
    context.mock.timers.tick(60000);
    await done.promise;
    assert.deepEqual(ai.calls, [prompts.summary, prompts.consolidate, prompts.consolidate]);
  } finally {
    await engine.stop();
    context.mock.timers.reset();
    data.cleanup();
  }
});
