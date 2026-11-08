import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { once } from 'node:events';
import sharp from 'sharp';
import {
  downloadQqImage,
  embedImages,
  isPublicImageAddress,
  prepareImage,
  validateQqImageUrl,
} from '../server/images.js';
import type { ContentPart } from '../server/ai-context.js';
import { deferred } from './helpers.js';

test('图片在提交前真实解码并转换，不依赖文件后缀，限制分辨率', async () => {
  const original = await sharp({
    create: { width: 2400, height: 1200, channels: 3, background: 'red' },
  })
    .webp()
    .toBuffer();
  const image = await prepareImage(
    'https://gchat.qpic.cn/not-a-webp.jpg',
    new AbortController().signal,
    undefined,
    async () => original,
  );
  assert.match(image.dataUrl, /^data:image\/jpeg;base64,/);
  const bytes = Buffer.from(image.dataUrl.split(',')[1] ?? '', 'base64');
  const metadata = await sharp(bytes).metadata();
  assert.equal(metadata.format, 'jpeg');
  assert.equal(metadata.width, 1920);
  assert.equal(metadata.height, 960);
  assert.equal(image.bytes, bytes.length);
  assert.equal(image.note, undefined);
});

test('动图转为单帧图片，并明确标注未分析完整动画', async () => {
  const bytes = Buffer.from(
    Array.from({ length: 16 }, (_, index) =>
      index % 4 === 3 ? 255 : index < 8 ? (index % 4 === 0 ? 255 : 0) : index % 4 === 2 ? 255 : 0,
    ),
  );
  const gif = await sharp(bytes, { raw: { width: 2, height: 2, channels: 4, pageHeight: 1 } })
    .gif({ delay: [100, 100], loop: 0 })
    .toBuffer();
  assert.equal((await sharp(gif, { animated: true }).metadata()).pages, 2);
  const image = await prepareImage(
    'https://gchat.qpic.cn/animated.gif',
    new AbortController().signal,
    undefined,
    async () => gif,
  );
  assert.match(image.note ?? '', /仅分析首帧/);
  const metadata = await sharp(Buffer.from(image.dataUrl.split(',')[1] ?? '', 'base64')).metadata();
  assert.equal(metadata.width, 2);
  assert.equal(metadata.height, 1);
  assert.notEqual(metadata.format, 'gif');
});

test('HTML、损坏图片、超限文件不作为图片提交；取消后不继续处理', async () => {
  for (const bytes of [
    Buffer.from('<html>expired image</html>'),
    Buffer.from([255, 216, 0, 1, 2]),
    Buffer.alloc(10 * 1024 * 1024 + 1),
  ]) {
    await assert.rejects(
      prepareImage(
        'https://gchat.qpic.cn/a.jpg',
        new AbortController().signal,
        undefined,
        async () => bytes,
      ),
      /图片/,
    );
  }
  const controller = new AbortController();
  const downloaded = deferred<Buffer>();
  const pending = prepareImage(
    'https://gchat.qpic.cn/a.jpg',
    controller.signal,
    undefined,
    async () => downloaded.promise,
  );
  controller.abort();
  downloaded.resolve(Buffer.from('cancelled'));
  await assert.rejects(pending, { name: 'AbortError' });
});

test('内嵌后图文位置与重复图片位置保留，动图备注位于对应图片前', async () => {
  const source: ContentPart[] = [
    { type: 'text', text: '前文' },
    { type: 'image_url', image_url: { url: 'first' } },
    { type: 'text', text: '中间' },
    { type: 'image_url', image_url: { url: 'second' } },
    { type: 'image_url', image_url: { url: 'first' } },
    { type: 'text', text: '后文' },
  ];
  const calls: string[] = [];
  const result = await embedImages(source, new AbortController().signal, undefined, async (url) => {
    calls.push(url);
    return {
      dataUrl: `data:image/png;base64,${Buffer.from(url).toString('base64')}`,
      bytes: url.length,
      note: url === 'second' ? '动图仅分析首帧' : undefined,
    };
  });
  assert.deepEqual(calls, ['first', 'second']);
  assert.ok(Array.isArray(result));
  assert.deepEqual(
    result.map((part) =>
      part.type === 'text'
        ? part.text
        : Buffer.from(part.image_url.url.split(',')[1] ?? '', 'base64').toString(),
    ),
    ['前文', 'first', '中间', '{"imageProcessing":"动图仅分析首帧"}', 'second', 'first', '后文'],
  );
  await assert.rejects(
    embedImages(source, new AbortController().signal, undefined, async () => ({
      dataUrl: 'data:image/png;base64,test',
      bytes: 7 * 1024 * 1024,
    })),
    /合计超过 12 MiB/,
  );
});

test('只允许 QQ 图片域名，拒绝本地网络、嵌入凭据、非默认端口和伪装域名', () => {
  for (const url of [
    'file:///etc/passwd',
    'http://127.0.0.1/a.png',
    'http://192.168.0.1/a.png',
    'https://gchat.qpic.cn.attacker.invalid/a',
    'https://attackerqpic.cn/a',
    'https://user:key@gchat.qpic.cn/a',
    'https://gchat.qpic.cn:8080/a',
  ])
    assert.throws(() => validateQqImageUrl(url));
  assert.equal(
    validateQqImageUrl('https://multimedia.nt.qq.com.cn/download?rkey=test').search,
    '?rkey=test',
  );
  for (const address of [
    '127.0.0.1',
    '10.0.0.1',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '::1',
    '::ffff:127.0.0.1',
    'fc00::1',
    'fe80::1',
    '2001:db8::1',
  ])
    assert.equal(isPublicImageAddress(address), false);
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])
    assert.equal(isPublicImageAddress(address), true);
});

test(
  '下载限制和取消生效，不跟随跳转，不向图片服务器发送 AI 密钥',
  { timeout: 5000 },
  async (context) => {
    let mode = 'image';
    let requests = 0;
    const started = deferred<void>();
    const server = http
      .createServer((request, response) => {
        requests++;
        assert.equal(request.headers.authorization, undefined);
        if (mode === 'redirect') {
          response.writeHead(302, { Location: 'http://127.0.0.1/private' });
          response.end();
          return;
        }
        if (mode === 'oversized') {
          response.writeHead(200, { 'Content-Length': String(11 * 1024 * 1024) });
          response.flushHeaders();
          return;
        }
        if (mode === 'cancel') {
          started.resolve();
          return;
        }
        response.end(Buffer.from([1, 2, 3]));
      })
      .listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    context.mock.method(
      https,
      'request',
      (
        _url: unknown,
        options: https.RequestOptions,
        callback: (response: http.IncomingMessage) => void,
      ) => {
        assert.equal(typeof options.lookup, 'function');
        assert.notEqual(options.rejectUnauthorized, false);
        return http.request(
          `http://127.0.0.1:${address.port}`,
          { signal: options.signal },
          callback,
        );
      },
    );
    const controller = new AbortController();
    try {
      assert.deepEqual(
        await downloadQqImage('https://gchat.qpic.cn/a.png', controller.signal),
        Buffer.from([1, 2, 3]),
      );
      mode = 'redirect';
      await assert.rejects(
        downloadQqImage('https://gchat.qpic.cn/a.png', controller.signal),
        /302/,
      );
      assert.equal(requests, 2);
      mode = 'oversized';
      await assert.rejects(
        downloadQqImage('https://gchat.qpic.cn/a.png', controller.signal),
        /10 MiB/,
      );
      mode = 'cancel';
      const pending = downloadQqImage('https://gchat.qpic.cn/a.png', controller.signal);
      await started.promise;
      controller.abort();
      await assert.rejects(pending, { name: 'AbortError' });
    } finally {
      controller.abort();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    }
  },
);
