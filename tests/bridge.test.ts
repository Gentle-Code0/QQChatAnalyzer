import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { z } from 'zod';
import { normalizeMessage, QqBridge, readActions, validateEndpoint } from '../server/bridge.js';
import { deferred } from './helpers.js';

test('自身发言正确识别接收者，保留群提及并拒绝其他账号事件', () => {
  const raw = {
    post_type: 'message_sent',
    self_id: 10001,
    message_type: 'private',
    user_id: 10001,
    target_id: 12345,
    message_id: -12,
    time: 10,
    message: '你好',
  };
  assert.equal(normalizeMessage(raw, '10001')?.peerId, '12345');
  assert.equal(normalizeMessage(raw, '10002'), undefined);
  assert.equal(normalizeMessage({ ...raw, target_id: undefined }, '10001'), undefined);
  const group = normalizeMessage(
    {
      ...raw,
      message_type: 'group',
      group_id: 22222,
      message: [
        { type: 'at', data: { qq: '10001' } },
        { type: 'text', data: { text: '周六见' } },
      ],
    },
    '10001',
  );
  assert.equal(group?.mentionedSelf, true);
  assert.match(group?.text ?? '', /周六见/);
  assert.equal(normalizeMessage({ ...raw, post_type: 'notice' }, '10001'), undefined);
});

test('连接地址拒绝嵌入凭据、查询参数及不适用的协议', () => {
  for (const value of [
    'file:///tmp/a',
    'ws://user:password@localhost',
    'ws://localhost/?token=test',
    'ws://localhost/#x',
  ]) {
    assert.throws(() => validateEndpoint(value, ['ws:', 'wss:']));
  }
  assert.equal(validateEndpoint('ws://192.168.1.2:3001', ['ws:']).port, '3001');
  assert.ok(readActions.every((action) => action.startsWith('get_')));
  assert.ok(!readActions.some((action) => /send|read|login_out|logout/.test(action)));
});

test('只读 WebSocket 验证身份、传递负锚点和 Token，停止后拒绝请求', { timeout: 5000 }, async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const ready = deferred<void>();
  const actions: string[] = [];
  server.on('connection', (socket, request) => {
    assert.equal(request.headers.authorization, 'Bearer invalid-test-token');
    socket.on('message', (bytes) => {
      const request = z
        .object({ action: z.string(), params: z.record(z.unknown()), echo: z.string() })
        .parse(JSON.parse(bytes.toString()));
      actions.push(request.action);
      if (request.action === 'get_friend_msg_history')
        assert.equal(request.params.message_id, -123);
      const data =
        request.action === 'get_login_info'
          ? { user_id: 10001 }
          : {
              messages: [
                {
                  message_type: 'private',
                  user_id: 12345,
                  message_id: -456,
                  time: 10,
                  message: '历史消息',
                },
              ],
            };
      socket.send(JSON.stringify({ retcode: 0, data, echo: request.echo }));
    });
  });
  const bridge = new QqBridge({
    url: `ws://127.0.0.1:${address.port}`,
    token: 'invalid-test-token',
    selfQq: '10001',
    onConnected: async () => ready.resolve(),
    onMessage: () => {},
    onStatus: () => {},
  });
  try {
    bridge.start();
    await ready.promise;
    const page = await bridge.history('12345', -123);
    assert.equal(page.cursor, -456);
    assert.equal(page.messages[0]?.peerId, '12345');
    assert.deepEqual(actions, ['get_login_info', 'get_friend_msg_history']);
    bridge.stop();
    await assert.rejects(bridge.request('get_friend_list', {}), /尚未连接/);
  } finally {
    bridge.stop();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
