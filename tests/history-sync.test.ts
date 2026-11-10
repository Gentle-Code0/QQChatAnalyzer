import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Application } from '../server/application.js';
import { QqBridge, type QqMessage } from '../server/bridge.js';
import { historySyncTiming } from '../server/history-sync.js';
import { Store } from '../server/store.js';
import { fixture, deferred } from './helpers.js';

type Page = Awaited<ReturnType<QqBridge['history']>>;
function message(
  id: number,
  kind: 'private' | 'group' = 'private',
  peerId = '12345',
  senderId = '12345',
): QqMessage {
  return {
    id: String(-id),
    kind,
    peerId,
    senderId,
    senderName: senderId,
    text: `历史内容 ${id}`,
    time: id * 1000,
    mentionedSelf: false,
  };
}
function page(...messages: QqMessage[]): Page {
  return {
    messages: [...messages].sort((a, b) => a.time - b.time),
    cursor: Number(
      messages.reduce<QqMessage | undefined>(
        (oldest, item) => (!oldest || item.time < oldest.time ? item : oldest),
        undefined,
      )?.id ?? 0,
    ),
    rawCount: messages.length,
  };
}
function bridge() {
  const result = new QqBridge({
    url: 'ws://example.invalid',
    selfQq: '10001',
    token: '',
    onStatus: () => {},
    onMessage: () => {},
    onConnected: async () => {},
  });
  result.connected = true;
  return result;
}
function setup(
  context: TestContext,
  respond: (
    peer: string,
    cursor: number,
    kind: 'private' | 'group',
    signal?: AbortSignal,
  ) => Page | Promise<Page>,
) {
  const data = fixture();
  data.store.settings = { ...data.store.settings, selfQq: '10001' };
  const app = new Application(data.store),
    qq = bridge();
  app.bridge = qq;
  app.ensureConversations(data.contact);
  context.mock.method(
    qq,
    'history',
    async (peer: string, cursor = 0, kind: 'private' | 'group' = 'private', signal?: AbortSignal) =>
      respond(peer, cursor, kind, signal),
  );
  return { data, app, id: `${data.contact.id}:private:${data.contact.qq}` };
}

test(
  '首次导入尚未结束也先从最新补缺口，实时重复和分页重叠不作为结束条件',
  { timeout: 5000 },
  async (context) => {
    const cursors: number[] = [];
    const { data, app, id } = setup(context, async (_peer, cursor) => {
      cursors.push(cursor);
      if (cursor === 0) {
        app.receive(message(6), 'live');
        return page(message(6), message(5), message(4));
      }
      if (cursor === -4) return page(message(4), message(3, 'private', '12345', '10001'));
      assert.equal(cursor, -3);
      return page(message(2), message(1));
    });
    try {
      app.receive(message(1), 'history');
      data.store.saveContact({ ...data.contact, historyCursor: -900, historyDone: false });
      await app.history.connected();
      assert.deepEqual(cursors, [0, -4, -3]);
      assert.equal(data.store.messageCount(id), 6);
      assert.equal(data.store.messages(id).find((item) => item.id.endsWith(':-6'))?.source, 'live');
      assert.equal(
        data.store.messages(id).find((item) => item.id.endsWith(':-3'))?.senderId,
        '10001',
      );
      assert.equal(data.store.historySync(id)?.initialCursor, -900);
      assert.equal(data.store.historySync(id)?.initialDone, false);
      assert.equal(data.store.historySync(id)?.recoveryPending, false);
      assert.match(data.store.conversation(id)!.historyStatus, /原消息锚点/);
      assert.ok(data.store.conversation(id)!.historyAnalysisSequence > 0);
      assert.equal(data.store.conversation(id)!.processedSequence, 0);
    } finally {
      await app.stop();
      data.cleanup();
    }
  },
);

test(
  '私聊与指定群均自动补读，群记录按对象独立落盘，暂停对象仍接收补读',
  { timeout: 5000 },
  async (context) => {
    const kinds: string[] = [];
    const { data, app, id } = setup(context, async (peer, _cursor, kind) => {
      kinds.push(kind);
      return kind === 'group'
        ? page(
            message(3, kind, peer, '99999'),
            message(2, kind, peer, '10001'),
            message(1, kind, peer),
          )
        : page(message(1));
    });
    try {
      data.store.saveContact({ ...data.contact, paused: true, groupIds: ['22222'] });
      app.ensureConversations(data.store.contact(data.contact.id)!);
      app.receive(message(1), 'history');
      app.receive(message(1, 'group', '22222'), 'history');
      await app.history.connected();
      const groupId = `${data.contact.id}:group:22222`;
      assert.deepEqual(kinds, ['private', 'group']);
      assert.equal(data.store.messageCount(id), 1);
      assert.equal(data.store.messageCount(groupId), 3);
      assert.ok(data.store.messages(groupId).every((item) => item.source === 'history'));
      assert.equal(
        data.store.messages(groupId).find((item) => item.id.endsWith(':-2'))?.senderId,
        '10001',
      );
      assert.equal(data.store.conversation(groupId)!.processedSequence, 0);
      assert.match(data.store.conversation(groupId)!.historyStatus, /原消息锚点/);
    } finally {
      await app.stop();
      data.cleanup();
    }
  },
);

test(
  '达到单批分页上限自动续读至固定锚点，不要求用户反复点击',
  { timeout: 5000 },
  async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const cursors: number[] = [];
    const { data, app, id } = setup(context, async (_peer, cursor) => {
      cursors.push(cursor);
      return cursor === 0
        ? page(message(5), message(4))
        : cursor === -4
          ? page(message(4), message(3))
          : cursor === -3
            ? page(message(3), message(2))
            : page(message(2), message(1));
    });
    try {
      data.store.settings = { ...data.store.settings, historyPages: 1 };
      app.receive(message(1), 'history');
      await app.history.connected();
      assert.equal(data.store.historySync(id)?.recoveryCursor, -4);
      assert.equal(app.history.isSyncing(id), true);
      for (let index = 0; index < 3; index++) {
        context.mock.timers.tick(historySyncTiming.continuationMs);
        await app.importHistory(data.contact.id);
      }
      assert.deepEqual(cursors, [0, -4, -3, -2]);
      assert.equal(data.store.messageCount(id), 5);
      assert.equal(data.store.historySync(id)?.recoveryPending, false);
      assert.equal(app.history.isSyncing(id), false);
    } finally {
      await app.stop();
      context.mock.timers.reset();
      data.cleanup();
    }
  },
);

test(
  '服务重启保留未完成缺口的旧锚点，同时重新扫描新增的最新记录',
  { timeout: 5000 },
  async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const { data, app, id } = setup(context, async () => page(message(5), message(4)));
    let restarted: Application | undefined;
    try {
      data.store.settings = { ...data.store.settings, historyPages: 1 };
      app.receive(message(1), 'history');
      await app.history.connected();
      assert.equal(data.store.historySync(id)?.boundaryId, 'private:12345:-1');
      await app.stop();
      const store = new Store(data.directory);
      restarted = new Application(store);
      const qq = bridge();
      restarted.bridge = qq;
      const cursors: number[] = [];
      context.mock.method(qq, 'history', async (_peer: string, cursor = 0) => {
        cursors.push(cursor);
        return cursor === 0
          ? page(message(6), message(5))
          : cursor === -5
            ? page(message(5), message(4), message(3))
            : page(message(3), message(2), message(1));
      });
      await restarted.history.connected();
      assert.equal(store.historySync(id)?.boundaryId, 'private:12345:-1');
      for (let index = 0; index < 2; index++) {
        context.mock.timers.tick(historySyncTiming.continuationMs);
        await restarted.importHistory(data.contact.id);
      }
      assert.deepEqual(cursors, [0, -5, -3]);
      assert.equal(store.messageCount(id), 6);
      assert.equal(store.historySync(id)?.recoveryPending, false);
    } finally {
      await restarted?.stop();
      await app.stop();
      context.mock.timers.reset();
      data.cleanup();
    }
  },
);

test('旧连接的迟到分页不落盘，也不能删除新连接的补读任务', { timeout: 5000 }, async (context) => {
  const first = deferred<void>(),
    old = deferred<Page>();
  let calls = 0;
  const { data, app, id } = setup(context, async () => {
    if (++calls === 1) {
      first.resolve();
      return old.promise;
    }
    return page(message(2), message(1));
  });
  try {
    app.receive(message(1), 'history');
    const earlier = app.history.connected();
    await first.promise;
    app.history.disconnected();
    const newer = app.history.connected();
    old.resolve(page(message(999)));
    await Promise.all([earlier, newer]);
    assert.equal(data.store.messageCount(id), 2);
    assert.ok(data.store.messages(id).every((item) => !item.id.endsWith(':-999')));
    assert.equal(data.store.historySync(id)?.recoveryPending, false);
    assert.equal(calls, 2);
  } finally {
    old.resolve(page());
    await app.stop();
    data.cleanup();
  }
});

test('分页失败保留成功页和游标，自动重试从失败页恢复', { timeout: 5000 }, async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let failed = false;
  const cursors: number[] = [];
  const { data, app, id } = setup(context, async (_peer, cursor) => {
    cursors.push(cursor);
    if (cursor === 0) return page(message(3));
    if (!failed) {
      failed = true;
      throw new Error('invalid-test-history-failure');
    }
    return page(message(2), message(1));
  });
  try {
    app.receive(message(1), 'history');
    await app.history.connected();
    assert.equal(data.store.historySync(id)?.recoveryCursor, -3);
    assert.equal(data.store.historySync(id)?.recoveryPending, true);
    assert.match(data.store.conversation(id)!.historyStatus, /失败.*自动重试/);
    assert.ok(data.store.conversation(id)!.historyAnalysisSequence > 0);
    context.mock.timers.tick(historySyncTiming.retryMs);
    await app.importHistory(data.contact.id);
    assert.deepEqual(cursors, [0, -3, -3]);
    assert.equal(data.store.messageCount(id), 3);
    assert.equal(data.store.historySync(id)?.recoveryPending, false);
  } finally {
    await app.stop();
    context.mock.timers.reset();
    data.cleanup();
  }
});

test(
  '上游不再提供旧锚点时保留缺口状态，不把分页结束宣称为补齐',
  { timeout: 5000 },
  async (context) => {
    let calls = 0;
    const { data, app, id } = setup(context, async (_peer, cursor) => {
      calls++;
      return cursor === 0 ? page(message(3), message(2)) : page();
    });
    try {
      app.receive(message(1), 'history');
      await app.history.connected();
      assert.equal(calls, 2);
      assert.equal(data.store.historySync(id)?.recoveryPending, true);
      assert.match(data.store.conversation(id)!.historyStatus, /尚未找到原锚点.*可能仍有缺口/);
      assert.equal(app.history.isSyncing(id), false);
    } finally {
      await app.stop();
      data.cleanup();
    }
  },
);

test('跨批游标循环会停止自动续读，关闭后不再执行续读计时器', { timeout: 5000 }, async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const { data, app, id } = setup(context, async (_peer, cursor) => {
    calls++;
    return {
      messages: [message(3)],
      cursor: cursor === 0 ? -3 : cursor === -3 ? -2 : -3,
      rawCount: 1,
    };
  });
  try {
    data.store.settings = { ...data.store.settings, historyPages: 1 };
    app.receive(message(1), 'history');
    await app.history.connected();
    for (let index = 0; index < 2; index++) {
      context.mock.timers.tick(historySyncTiming.continuationMs);
      await app.importHistory(data.contact.id);
    }
    assert.equal(calls, 3);
    assert.match(data.store.conversation(id)!.historyStatus, /分页无法前进/);
    assert.equal(app.history.isSyncing(id), false);
    await app.stop();
    context.mock.timers.tick(1000000);
    assert.equal(calls, 3);
  } finally {
    await app.stop();
    context.mock.timers.reset();
    data.cleanup();
  }
});
