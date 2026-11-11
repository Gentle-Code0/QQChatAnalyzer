import test from 'node:test';
import assert from 'node:assert/strict';
import { QqBridge, normalizeMessage, BridgeRequestError } from '../server/bridge.js';
import { settingsSchema } from '../shared/schema.js';
import { fixture } from './helpers.js';

test('NapCat uses string message_seq for both history actions and distinguishes unreadable anchors', async (t) => {
  const bridge = new QqBridge({
    provider: 'napcat',
    url: 'ws://example.invalid',
    token: '',
    selfQq: '10001',
    onMessage: () => {},
    onStatus: () => {},
    onConnected: async () => {},
  });
  const calls: unknown[] = [];
  t.mock.method(
    bridge,
    'request',
    async (action: string, params: Record<string, string | number | boolean>) => {
      calls.push({ action, params });
      return {
        messages: [
          {
            message_type: action === 'get_friend_msg_history' ? 'private' : 'group',
            group_id: 22222,
            user_id: 12345,
            message_id: 12,
            real_seq: '999',
            time: 10,
            message: 'hello',
          },
        ],
      };
    },
  );
  const page = await bridge.history('12345', 42);
  assert.equal(page.cursor, 12);
  await bridge.history('22222', 43, 'group');
  assert.deepEqual(calls, [
    {
      action: 'get_friend_msg_history',
      params: { user_id: '12345', count: 100, message_seq: '42', reverse_order: true },
    },
    {
      action: 'get_group_msg_history',
      params: { group_id: '22222', count: 100, message_seq: '43', reverse_order: true },
    },
  ]);
  t.mock.method(bridge, 'request', async () => {
    throw new BridgeRequestError('消息42不存在');
  });
  assert.equal((await bridge.history('12345', 42)).unavailable, true);
  t.mock.method(bridge, 'request', async () => {
    throw new BridgeRequestError('network failure');
  });
  await assert.rejects(bridge.history('12345', 42));
  t.mock.method(bridge, 'request', async () => ({ messages: [] }));
  assert.equal((await bridge.history('12345', 42)).unavailable, undefined);
});

test('shared group sequence binds provider aliases; legacy identity hydration preserves references', () => {
  const data = fixture();
  try {
    const old = {
      ...data.message('group:22222:-10'),
      time: 1000,
      identities: [
        { provider: 'snowluma' as const, account: '10001', id: '-10', groupSequence: '91' },
      ],
    };
    assert.equal(data.store.addMessage(old), true);
    assert.equal(
      data.store.addMessage({
        ...old,
        id: 'napcat:group:22222:20',
        identities: [{ provider: 'napcat', account: '10001', id: '20', groupSequence: '91' }],
      }),
      false,
    );
    assert.equal(data.store.messages('conversation')[0]?.identities?.length, 2);
    assert.equal(
      data.store.messageMatches('conversation', old.id, {
        provider: 'napcat',
        account: '10001',
        id: '20',
      }),
      true,
    );
    const legacy = { ...data.message('private:12345:-77'), time: 2000 };
    data.store.addMessage(legacy);
    assert.equal(
      data.store.addMessage({
        ...legacy,
        identities: [{ provider: 'snowluma', account: '10001', id: '-77', rawSequence: '7' }],
      }),
      false,
    );
    assert.equal(
      data.store.messages('conversation').find((m) => m.id === legacy.id)?.identities?.[0]
        ?.rawSequence,
      '7',
    );
  } finally {
    data.cleanup();
  }
});

test('weak content associations never collapse repeats or compare incompatible private sequences', () => {
  const data = fixture();
  try {
    const old = {
      ...data.message('private:12345:-1'),
      time: 1000,
      identities: [
        { provider: 'snowluma' as const, account: '10001', id: '-1', rawSequence: '91' },
      ],
    };
    data.store.addMessage(old);
    const next = {
      ...old,
      id: 'napcat:private:12345:2',
      identities: [{ provider: 'napcat' as const, account: '10001', id: '2', rawSequence: '91' }],
    };
    assert.equal(data.store.addMessage(next), true);
    assert.equal(
      data.store.messages('conversation')[1]?.associations?.[0]?.evidence,
      'content-time',
    );
    assert.equal(data.store.addMessage(next), false);
    assert.equal(data.store.messageCount('conversation'), 2);
  } finally {
    data.cleanup();
  }
});

test('settings default to SnowLuma and preserve separate URLs; metadata uses provider-specific group fields', () => {
  assert.equal(settingsSchema.parse({ qqUrl: 'ws://example.invalid' }).bridgeProvider, 'snowluma');
  const raw = {
    message_type: 'group',
    group_id: 22222,
    user_id: 12345,
    message_id: 1,
    message_seq: 2,
    real_seq: '3',
    time: 10,
    message: 'hello',
  };
  assert.equal(
    normalizeMessage(raw, '10001', undefined, 'napcat')?.identities?.[0]?.groupSequence,
    '3',
  );
  assert.equal(normalizeMessage(raw, '10001')?.identities?.[0]?.groupSequence, '2');
});
