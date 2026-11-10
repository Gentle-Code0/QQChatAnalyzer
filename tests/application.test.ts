import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { z } from 'zod';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Workspace } from '../web/workspace.js';
import { Application } from '../server/application.js';
import { QqBridge } from '../server/bridge.js';
import { AnalysisEngine } from '../server/engine.js';
import { prompts, type AiClient } from '../server/ai.js';
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
            message: [
              { type: 'text', data: { text: `测试消息 ${id}` } },
              {
                type: 'image',
                data: { file: `test-${id}.png`, url: `https://example.invalid/${id}.png` },
              },
            ],
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
    const saved = data.store.messages(conversationId);
    assert.equal(
      saved.filter((message) => message.segments?.some((part) => part.type === 'image')).length,
      3,
    );
    assert.deepEqual(saved.find((message) => message.id.endsWith(':-1'))?.segments, [
      { type: 'text', text: '测试消息 -1' },
      { type: 'image', file: 'test--1.png', url: 'https://example.invalid/-1.png' },
    ]);
  } finally {
    await application.stop();
    data.cleanup();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test(
  '自身私聊从 WebSocket 入库、去重并进入双方分析上下文；接收计数区分未解析事件',
  { timeout: 5000 },
  async () => {
    const data = fixture();
    data.store.settings = { ...data.store.settings, selfQq: '10001' };
    const application = new Application(data.store);
    application.ensureConversations(data.contact);
    const id = `${data.contact.id}:private:${data.contact.qq}`;
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const socketReady = deferred<import('ws').WebSocket>();
    const ready = deferred<void>();
    const reconnected = deferred<void>();
    let connections = 0;
    const received = deferred<void>();
    let deliveries = 0;
    server.on('connection', (socket) => {
      socketReady.resolve(socket);
      socket.on('message', (bytes) => {
        const request = z
          .object({ action: z.string(), echo: z.string() })
          .parse(JSON.parse(bytes.toString()));
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
      onConnected: async () => {
        if (++connections === 1) ready.resolve();
        else reconnected.resolve();
      },
      onMessage: (message) => {
        application.receive(message, 'live');
        if (++deliveries === 3) received.resolve();
      },
    });
    application.bridge = bridge;
    const analyzed = deferred<void>();
    const contexts: unknown[] = [];
    const ai: AiClient = {
      async call<T>(instruction: string, context: unknown, schema: z.ZodType<T>): Promise<T> {
        if (instruction === prompts.summary) {
          contexts.push(context);
          return schema.parse({
            compressedPreviousSummary: '',
            summary: '双方讨论活动安排',
            relevant: true,
            significant: false,
            attitude: 0,
            emotion: 0,
            mood: '平静',
            reason: '测试双方消息',
            adviceSignal: { worthChecking: false, reason: '无需行动' },
          });
        }
        if (instruction === prompts.gate)
          return schema.parse({ needed: false, reason: '无需行动', keywords: [] });
        return schema.parse({ traits: {}, traitSourceIds: {}, memories: [] });
      },
    };
    const engine = new AnalysisEngine(data.store, ai, () => {
      if (data.store.conversation(id)?.consolidatedSequence) analyzed.resolve();
    });
    try {
      bridge.start();
      await ready.promise;
      const socket = await socketReady.promise;
      const incoming = {
        self_id: 10001,
        post_type: 'message',
        message_type: 'private',
        user_id: 12345,
        message_id: -10,
        time: 10,
        message: '周末有什么安排？',
      };
      const outgoing = {
        ...incoming,
        post_type: 'message_sent',
        user_id: 10001,
        target_id: 12345,
        message_id: -11,
        time: 11,
        message: '我打算去公园走走。',
      };
      // Wrong-account events are excluded; a missing receiver must remain rejected.
      for (const event of [
        incoming,
        outgoing,
        outgoing,
        { ...outgoing, target_id: undefined },
        { ...outgoing, self_id: 20002 },
      ])
        socket.send(JSON.stringify(event));
      await received.promise;
      // A request/response is an event-loop barrier, without arbitrary waits.
      await bridge.request('get_friend_list', {});
      assert.deepEqual(application.snapshot().bridge.reception, {
        incoming: 1,
        selfReceived: 3,
        selfAccepted: 2,
      });
      assert.equal(data.store.messageCount(id), 2);
      const saved = data.store.recentMessages(id);
      assert.deepEqual(
        saved.map((message) => [message.senderId, message.text]),
        [
          ['12345', incoming.message],
          ['10001', outgoing.message],
        ],
      );
      assert.ok(saved.every((message) => message.source === 'live'));
      const html = renderToStaticMarkup(
        createElement(Workspace, {
          state: application.snapshot(),
          contact: data.contact,
          conversation: data.store.conversation(id),
          detail: { messages: saved, memories: [], observations: [], decisions: [], activity: [] },
          selectConversation: () => {},
          edit: () => {},
          action: async () => {},
        }),
      );
      assert.ok(html.includes(incoming.message));
      assert.ok(html.includes(outgoing.message));
      assert.match(html, /class="message self"/);
      engine.flush(id);
      await analyzed.promise;
      const context = z
        .object({
          messages: z.array(
            z.object({
              senderId: z.string(),
              senderRole: z.string(),
              text: z.string(),
            }),
          ),
        })
        .parse(contexts[0]);
      assert.deepEqual(
        context.messages.map(({ senderId, senderRole, text }) => [senderId, senderRole, text]),
        [
          ['12345', 'contact', incoming.message],
          ['10001', 'self', outgoing.message],
        ],
      );
      bridge.stop();
      bridge.start();
      await reconnected.promise;
      assert.deepEqual(bridge.reception, { incoming: 0, selfReceived: 0, selfAccepted: 0 });
    } finally {
      await engine.stop();
      await application.stop();
      data.cleanup();
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
