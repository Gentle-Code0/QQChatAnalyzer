import test from 'node:test';
import assert from 'node:assert/strict';
import { buildContextContent, ImageContextError } from '../server/ai-context.js';
import { messageSchema, type MessageSegment } from '../shared/schema.js';
import { deferred } from './helpers.js';

function message(id: string, segments?: MessageSegment[]) {
  return messageSchema.parse({
    id,
    conversationId: 'test',
    senderId: '12345',
    senderName: '测试对象',
    text: '旧文字',
    time: 10,
    source: 'live',
    segments,
  });
}

test('多消息和单条多图片均保留图文顺序、消息身份与图片位置', async () => {
  const signal = new AbortController().signal;
  const resolved: string[] = [];
  const content = await buildContextContent(
    {
      summary: '已有摘要',
      recentContext: [
        { ...message('old', [{ type: 'image', file: 'old.png' }]), senderRole: 'contact' },
      ],
      messages: [
        {
          ...message('first', [
            { type: 'text', text: '这是第一张' },
            { type: 'image', file: 'first.png' },
            { type: 'text', text: '这是第二张' },
            { type: 'image', file: 'second.png' },
            { type: 'text', text: '你觉得哪张好？' },
          ]),
          senderRole: 'contact',
        },
        { ...message('reply'), senderId: '10001', senderRole: 'self' },
        message('repeated', [{ type: 'image', file: 'first.png' }]),
      ],
    },
    async (image) => {
      assert.ok(image.file);
      resolved.push(image.file);
      return `https://example.invalid/${image.file}?rkey=test`;
    },
    signal,
  );
  assert.ok(Array.isArray(content));
  assert.deepEqual(resolved, ['old.png', 'first.png', 'second.png']);
  assert.deepEqual(
    content.map((part) => (part.type === 'image_url' ? part.image_url.url : JSON.parse(part.text))),
    [
      { context: { summary: '已有摘要' } },
      {
        section: 'recentContext',
        message: { ...message('old'), text: undefined, segments: undefined, senderRole: 'contact' },
      },
      { segment: 1, type: 'image' },
      'https://example.invalid/old.png?rkey=test',
      { endMessage: 'old' },
      {
        section: 'messages',
        message: {
          ...message('first'),
          text: undefined,
          segments: undefined,
          senderRole: 'contact',
        },
      },
      { segment: 1, type: 'text', text: '这是第一张' },
      { segment: 2, type: 'image' },
      'https://example.invalid/first.png?rkey=test',
      { segment: 3, type: 'text', text: '这是第二张' },
      { segment: 4, type: 'image' },
      'https://example.invalid/second.png?rkey=test',
      { segment: 5, type: 'text', text: '你觉得哪张好？' },
      { endMessage: 'first' },
      {
        section: 'messages',
        message: {
          ...message('reply'),
          text: undefined,
          segments: undefined,
          senderId: '10001',
          senderRole: 'self',
        },
      },
      { segment: 1, type: 'text', text: '旧文字' },
      { endMessage: 'reply' },
      {
        section: 'messages',
        message: { ...message('repeated'), text: undefined, segments: undefined },
      },
      { segment: 1, type: 'image' },
      'https://example.invalid/first.png?rkey=test',
      { endMessage: 'repeated' },
    ].map((part) => (typeof part === 'string' ? part : JSON.parse(JSON.stringify(part)))),
  );
});

test('旧版纯文本消息兼容，不触发图片接口', async () => {
  const context = { messages: [message('old')] };
  assert.equal(
    await buildContextContent(
      context,
      async () => {
        throw new Error('不应调用');
      },
      new AbortController().signal,
    ),
    JSON.stringify(context),
  );
});

test('图片解析失败、危险地址和过量图片均显式失败，不以占位符冒充已看图', async () => {
  const context = { messages: [message('1', [{ type: 'image', file: 'one' }])] };
  for (const url of [
    'file:///etc/passwd',
    'https://user:secret@example.invalid/img',
    'data:image/png;base64,invalid',
    'javascript:alert(1)',
  ]) {
    await assert.rejects(
      buildContextContent(context, async () => url, new AbortController().signal),
      ImageContextError,
    );
  }
  await assert.rejects(
    buildContextContent(
      context,
      async () => {
        throw new Error('upstream-secret');
      },
      new AbortController().signal,
    ),
    /无法读取消息图片/,
  );
  const many = {
    messages: [
      message(
        'many',
        Array.from({ length: 101 }, () => ({ type: 'image', file: 'one' })),
      ),
    ],
  };
  await assert.rejects(
    buildContextContent(
      many,
      async () => {
        throw new Error('不应调用');
      },
      new AbortController().signal,
    ),
    /超过 100 张图片/,
  );
});

test('取图过程中取消后，不再解析后续图片或返回可提交上下文', async () => {
  const controller = new AbortController();
  const started = deferred<void>();
  const image = deferred<string>();
  let calls = 0;
  const result = buildContextContent(
    {
      messages: [
        message('1', [
          { type: 'image', file: '1' },
          { type: 'image', file: '2' },
        ]),
      ],
    },
    async () => {
      calls++;
      started.resolve();
      return image.promise;
    },
    controller.signal,
  );
  await started.promise;
  controller.abort();
  image.resolve('https://example.invalid/1');
  await assert.rejects(result, { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('历史页顺序不同时按消息时间组织图文，相同时间按消息序号排序', async () => {
  const content = await buildContextContent(
    {
      recentContext: [{ ...message('later', [{ type: 'image', file: 'later' }]), time: 30 }],
      messages: [
        { ...message('second', [{ type: 'image', file: 'second' }]), time: 10, sequence: 2 },
        { ...message('first', [{ type: 'image', file: 'first' }]), time: 10, sequence: 1 },
      ],
    },
    async (image) => `https://example.invalid/${image.file}`,
    new AbortController().signal,
  );
  assert.ok(Array.isArray(content));
  assert.deepEqual(
    content.filter((part) => part.type === 'image_url').map((part) => part.image_url.url),
    [
      'https://example.invalid/first',
      'https://example.invalid/second',
      'https://example.invalid/later',
    ],
  );
});
