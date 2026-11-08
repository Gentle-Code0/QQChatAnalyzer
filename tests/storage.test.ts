import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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

test('旧档案默认未填写性别并保留简介，性别和画像重新打开后保留', () => {
  const data = fixture();
  try {
    const legacy = {
      id: 'legacy',
      name: '旧档案',
      qq: '54321',
      bio: '原来的关系简介',
      traits: { likes: '读书', boundaries: '', communication: '直接沟通' },
      createdAt: 1,
    };
    const database = new DatabaseSync(join(data.directory, 'chat.sqlite'));
    try {
      database
        .prepare('INSERT INTO records VALUES(?,?,?)')
        .run('contact', legacy.id, JSON.stringify(legacy));
    } finally {
      database.close();
    }
    const oldContact = data.store.contact(legacy.id);
    assert.equal(oldContact?.gender, '未填写');
    assert.equal(oldContact?.bio, legacy.bio);
    assert.deepEqual(oldContact?.traits, legacy.traits);
    data.store.saveContact({ ...data.contact, gender: '男', traits: legacy.traits });
    const reopened = new Store(data.directory);
    try {
      assert.equal(reopened.contact(data.contact.id)?.gender, '男');
      assert.deepEqual(reopened.contact(data.contact.id)?.traits, legacy.traits);
      assert.equal(reopened.contact(legacy.id)?.bio, legacy.bio);
    } finally {
      reopened.close();
    }
  } finally {
    data.cleanup();
  }
});
