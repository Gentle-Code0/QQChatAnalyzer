import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { z } from 'zod';
import { Application } from '../server/application.js';
import { QqBridge } from '../server/bridge.js';
import { fixture, deferred } from './helpers.js';

test('历史分页达到上限可继续，重复边界去重，完成后重连只补读缺口', { timeout: 5000 }, async () => {
  const data = fixture();
  data.store.settings = { ...data.store.settings, historyPages: 1 };
  const application = new Application(data.store);
  application.ensureConversations(data.contact);
  const conversationId = `${data.contact.id}:private:${data.contact.qq}`;
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const ready = deferred<void>();
  const cursors: number[] = [];
  server.on('connection', (socket) =>
    socket.on('message', (bytes) => {
      const request = z
        .object({ action: z.string(), params: z.record(z.unknown()), echo: z.string() })
        .parse(JSON.parse(bytes.toString()));
      let response: unknown = { user_id: 10001 };
      if (request.action === 'get_friend_msg_history') {
        const cursor = z.number().parse(request.params.message_id);
        cursors.push(cursor);
        const ids = cursor === 0 ? [-2, -1] : cursor === -2 ? [-3, -2] : [];
        response = {
          messages: ids.map((id) => ({
            message_type: 'private',
            user_id: 12345,
            message_id: id,
            time: 100 + id,
            message: `测试消息 ${id}`,
          })),
        };
      }
      socket.send(JSON.stringify({ retcode: 0, data: response, echo: request.echo }));
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
  application.bridge = bridge;
  try {
    bridge.start();
    await ready.promise;
    await application.importHistory(data.contact.id);
    assert.equal(data.store.contact(data.contact.id)?.historyDone, false);
    assert.equal(data.store.messageCount(conversationId), 2);
    await application.importHistory(data.contact.id);
    assert.equal(data.store.messageCount(conversationId), 3);
    await application.importHistory(data.contact.id);
    assert.equal(data.store.contact(data.contact.id)?.historyDone, true);
    await application.importHistory(data.contact.id);
    assert.equal(data.store.messageCount(conversationId), 3);
    assert.equal(data.store.contact(data.contact.id)?.historyCount, 3);
    assert.deepEqual(cursors, [0, -2, -3, 0]);
  } finally {
    await application.stop();
    data.cleanup();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
