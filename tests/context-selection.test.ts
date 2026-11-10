import test from 'node:test';
import assert from 'node:assert/strict';
import { messageSchema, memorySchema, analysisContextLimits } from '../shared/schema.js';
import {
  compactText,
  selectBridgeMessages,
  selectDecisionEvidence,
  selectDuplicateMemories,
  selectRelatedTraits,
  excerptMessage,
  compactSignals,
} from '../server/context-selection.js';

function message(id: string, text: string, sequence = 1) {
  return messageSchema.parse({
    id,
    text,
    sequence,
    conversationId: 'chat',
    senderId: '12345',
    senderName: '对象',
    time: sequence * 1000,
    source: 'live',
  });
}
function memory(id: string, text: string, time: number, contactId = 'contact') {
  return memorySchema.parse({
    id,
    contactId,
    text,
    kind: 'promise',
    time,
    createdAt: time,
    sourceIds: ['old'],
    keywords: [],
  });
}

test('指代式新消息携带承接问题，完整独立话题不携带无关原文，身份和时间不混淆', () => {
  const question = message('question', '周六下午在老地方见面好吗？', 1);
  const unrelated = message('unrelated', '服务器日志已导出。', 2);
  const outsider = { ...message('outsider', '周六见面好吗？', 3), senderId: 'other' };
  const future = message('future', '周六的安排需要确认？', 100);
  const selected = selectBridgeMessages(
    [question, unrelated, outsider, future],
    [message('new', '可以，还是老地方', 4)],
    ['12345'],
  );
  assert.ok(selected.some((item) => item.id === question.id));
  assert.ok(selected.every((item) => item.senderId === '12345' && item.time <= 4000));
  assert.deepEqual(
    selectBridgeMessages(
      [unrelated],
      [message('independent', '下个月准备去北京旅游', 5)],
      ['12345'],
    ),
    [],
  );
  assert.deepEqual(selectBridgeMessages([question], [], ['12345']), []);
});

test('消息文字节选有上限，保留原身份和所有图片段落，原消息不被修改', () => {
  const image = { type: 'image' as const, file: 'invalid-test.png' };
  const original = {
    ...message('long', '长'.repeat(4000)),
    segments: [
      { type: 'text' as const, text: '前'.repeat(2000) },
      image,
      { type: 'text' as const, text: '后'.repeat(2000) },
    ],
  };
  const selected = excerptMessage(original, 500);
  assert.equal(selected.text.length, 500);
  assert.ok(
    selected
      .segments!.filter((item) => item.type === 'text')
      .reduce((sum, item) => sum + item.text.length, 0) <= 500,
  );
  assert.equal(selected.segments![1], image);
  assert.equal(selected.senderId, original.senderId);
  assert.equal(selected.id, original.id);
  assert.equal(original.text.length, 4000);
  assert.equal(compactText('abc', 0), '');
  const emojiExcerpt = compactText('😀'.repeat(100), 9);
  assert.ok(emojiExcerpt.length <= 9);
  assert.ok(!/[\uD800-\uDFFF]/u.test(emojiExcerpt.replace(/😀/gu, '')));
});

test('建议证据优先保留突变来源，再保留近期双方发言，最多六条', () => {
  const messages = Array.from({ length: 25 }, (_, index) =>
    message(String(index), '普通发言'.repeat(200), index + 1),
  );
  const signals = [
    {
      id: 'signal',
      conversationId: 'chat',
      time: 1,
      attitude: 0,
      emotion: 0,
      mood: '',
      reason: '',
      relevant: true,
      significant: true,
      sourceIds: ['0'],
    },
  ];
  const evidence = selectDecisionEvidence(messages, signals, ['12345']);
  assert.equal(evidence.length, analysisContextLimits.decisionEvidenceMessages);
  assert.equal(evidence[0]?.id, '0');
  assert.equal(evidence.at(-1)?.id, '24');
  assert.ok(evidence.every((item) => item.text.length <= 500));
  const compact = compactSignals([
    ...signals,
    { ...signals[0]!, attitude: 12, emotion: -7, reason: '理由'.repeat(500) },
  ]);
  assert.equal(compact?.attitudeChange, 12);
  assert.equal(compact?.emotionChange, -7);
  assert.ok(compact!.reason.length <= 300);
});

test('候选记忆从整个对象历史检索，较旧相关记录不被六十条新闲聊挤掉，其他对象隔离', () => {
  const old = {
    ...memory('old-appointment', '对象确认周六在公园见面', 1),
    keywords: ['周六', '公园'],
  };
  const recent = Array.from({ length: 70 }, (_, index) =>
    memory(`recent-${index}`, '更新服务器配置文件', 100 + index),
  );
  const other = memory('other-contact', old.text, 999, 'another');
  const selected = selectDuplicateMemories(
    [old, ...recent, other],
    [message('new', '周六见面改到周日，公园位置不变')],
    'contact',
  );
  assert.deepEqual(
    selected.map((item) => item.id),
    ['old-appointment'],
  );
  assert.deepEqual(
    selectDuplicateMemories([old], [message('irrelevant', '数据库完成备份')], 'contact'),
    [],
  );
  // New progress stays in the raw batch; retrieval only supplies candidates, never discards it.
  assert.equal(selected[0]?.text, old.text);
});

test('候选记忆遵守数量和总文本预算，同源证据可命中无共同关键词的旧记录', () => {
  const candidates = Array.from({ length: 20 }, (_, index) =>
    memory(String(index), '周六公园见面'.repeat(200), index),
  );
  const sameSource = { ...memory('same-source', '完全不同的描述', 0), sourceIds: ['new'] };
  const selected = selectDuplicateMemories(
    [...candidates, sameSource],
    [message('new', '周六公园见面')],
    'contact',
  );
  assert.equal(selected[0]?.id, sameSource.id);
  assert.ok(selected.length <= 8);
  assert.ok(selected.reduce((sum, item) => sum + item.text.length, 0) <= 6000);
});

test('只传相关画像字段，空字段允许引入新画像，不截断相关字段原有内容', () => {
  const traits = {
    likes: '偏好阅读小说，不吃花生',
    boundaries: '不公开家庭住址',
    communication: '倾向先写文字再交流',
  };
  assert.deepEqual(selectRelatedTraits(traits, [message('new', '我喜欢登山')]), {
    likes: traits.likes,
  });
  assert.deepEqual(selectRelatedTraits(traits, [message('new', '服务器已重启')]), {});
  assert.deepEqual(selectRelatedTraits({ ...traits, likes: '' }, [message('new', '准备去游泳')]), {
    likes: '',
  });
});
