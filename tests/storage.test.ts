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

test('独立调度默认值及旧设置兼容，退休的冷却设置被忽略', () => {
  const defaults = settingsSchema.parse({});
  assert.equal(defaults.mergeWindowSeconds, 60);
  assert.equal(defaults.idleSeconds, 120);
  assert.equal(defaults.messageThreshold, 30);
  assert.equal(defaults.summaryMessageThreshold, 20);
  assert.equal(defaults.summaryIdleSeconds, 60);
  assert.equal(defaults.consolidationMessageThreshold, 100);
  assert.equal(defaults.consolidationIdleSeconds, 600);
  const legacy = settingsSchema.parse({
    mergeWindowSeconds: 3,
    idleSeconds: 15,
    messageThreshold: 12,
    cooldownMinutes: 10,
  });
  assert.equal(legacy.mergeWindowSeconds, 3);
  assert.equal(legacy.idleSeconds, 15);
  assert.equal(legacy.messageThreshold, 12);
  assert.equal(legacy.summaryMessageThreshold, 20);
  assert.equal('cooldownMinutes' in legacy, false);
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

test('单模型设置兼容旧配置且优先保留显式模型名称', () => {
  assert.equal(settingsSchema.parse({}).model, 'gpt-4o');
  const migrated = settingsSchema.parse({
    fullModel: 'custom-vision',
    lightModel: 'custom-small',
    cooldownMinutes: 10,
  });
  assert.equal(migrated.model, 'custom-vision');
  assert.equal('cooldownMinutes' in migrated, false);
  assert.equal('lightModel' in migrated, false);
  assert.equal('fullModel' in migrated, false);
  assert.equal(settingsSchema.parse({ lightModel: 'only-legacy' }).model, 'only-legacy');
  assert.equal(settingsSchema.parse({ model: 'chosen', fullModel: 'legacy' }).model, 'chosen');
});

test('图文消息重新打开后保持段落顺序，重复消息不覆盖图片资料', () => {
  const data = fixture();
  try {
    const message = {
      ...data.message('picture'),
      segments: [
        { type: 'text' as const, text: '第一张' },
        { type: 'image' as const, file: 'first.png', url: 'https://example.invalid/first.png' },
        { type: 'text' as const, text: '第二张' },
        { type: 'image' as const, file: 'second.png' },
      ],
    };
    assert.equal(data.store.addMessage(message), true);
    assert.equal(data.store.addMessage(data.message('picture')), false);
    const reopened = new Store(data.directory);
    try {
      assert.deepEqual(reopened.messages(data.conversation.id)[0]?.segments, message.segments);
    } finally {
      reopened.close();
    }
  } finally {
    data.cleanup();
  }
});

test('对话显示按发送时间选择最近 200 条，较晚补读的旧消息不挤掉新消息', () => {
  const data = fixture();
  try {
    data.store.addMessage({ ...data.message('live'), time: 5000 });
    for (let index = 209; index >= 0; index--) {
      data.store.addMessage({
        ...data.message(`history-${index}`),
        time: 1000 + index,
        source: 'history',
      });
    }
    const recent = data.store.recentMessages(data.conversation.id);
    assert.equal(recent.length, 200);
    assert.equal(recent[0]?.id, 'history-11');
    assert.equal(recent.at(-1)?.id, 'live');
    assert.ok(
      recent.every((message, index) => index === 0 || message.time >= recent[index - 1]!.time),
    );
    assert.equal(
      recent.some((message) => message.id === 'history-0'),
      false,
    );
    // The analysis cursor must continue to see older messages inserted after live messages.
    const pending = data.store.pendingMessages(data.conversation.id, recent.at(-1)!.sequence);
    assert.equal(pending[0]?.id, 'history-209');
    assert.ok(pending.every((message) => message.sequence > recent.at(-1)!.sequence));
  } finally {
    data.cleanup();
  }
});

test('同一发送时间按入库序号稳定排序，过滤会话且只对选中范围排序', () => {
  const data = fixture();
  try {
    for (const [id, time] of [
      ['newest', 3000],
      ['tie-first', 2000],
      ['oldest', 1000],
      ['tie-second', 2000],
    ] as const) {
      data.store.addMessage({ ...data.message(id), time });
    }
    data.store.addMessage({ ...data.message('other'), conversationId: 'other', time: 4000 });
    assert.deepEqual(
      data.store.recentMessages(data.conversation.id).map((message) => message.id),
      ['oldest', 'tie-first', 'tie-second', 'newest'],
    );
    assert.deepEqual(
      data.store.recentMessages(data.conversation.id, 2).map((message) => message.id),
      ['tie-second', 'newest'],
    );
    assert.deepEqual(data.store.recentMessages('empty'), []);
  } finally {
    data.cleanup();
  }
});
