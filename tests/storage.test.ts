import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from './helpers.js';
import { Store } from '../server/store.js';
import { retrieveMemories } from '../server/engine.js';
import type { Memory } from '../shared/schema.js';
import { settingsSchema } from '../shared/schema.js';

test('新设置默认合并 3 秒、冷却 1 分钟，已有显式冷却配置保留', () => {
  const defaults = settingsSchema.parse({});
  assert.equal(defaults.mergeWindowSeconds, 3);
  assert.equal(defaults.cooldownMinutes, 1);
  assert.equal(settingsSchema.parse({ cooldownMinutes: 10 }).cooldownMinutes, 10);
});

test('密钥加密落盘，重新打开后可解密；消息按会话去重', () => {
  const data = fixture();
  try {
    const key = 'invalid-test-placeholder-key';
    data.store.setSecret('apiKey', key);
    assert.equal(data.store.secret('apiKey'), key);
    assert.equal(data.store.addMessage(data.message('1')), true);
    assert.equal(data.store.addMessage(data.message('1')), false);
    assert.equal(data.store.addMessage({ ...data.message('1'), conversationId: 'another' }), true);
    const second = new Store(data.directory);
    try {
      assert.equal(second.secret('apiKey'), key);
    } finally {
      second.close();
    }
    for (const name of ['chat.sqlite', 'chat.sqlite-wal']) {
      assert.equal(readFileSync(join(data.directory, name)).includes(Buffer.from(key)), false);
    }
    assert.equal(data.store.messages(data.conversation.id).length, 1);
  } finally {
    data.cleanup();
  }
});

test('记忆检索必须命中关键词，较旧事件权重衰减', () => {
  const now = Date.now();
  const base: Memory = {
    id: 'recent',
    contactId: 'alice',
    kind: 'promise',
    text: '周六见面',
    time: now,
    createdAt: now,
    sourceIds: ['1'],
    keywords: ['见面'],
  };
  const memories = [
    base,
    { ...base, id: 'old', time: now - 365 * 86400000 },
    { ...base, id: 'unrelated', text: '天气', keywords: [] },
  ];
  assert.deepEqual(
    retrieveMemories(memories, ['见面'], now).map((item) => item.id),
    ['recent', 'old'],
  );
  assert.deepEqual(retrieveMemories(memories, [], now), []);
});
