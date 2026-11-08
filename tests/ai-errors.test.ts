import test from 'node:test';
import assert from 'node:assert/strict';
import { providerErrorHint } from '../server/ai-errors.js';

test('兼容不同供应商的顶层和嵌套错误，不根据供应商编号推断原因', async () => {
  for (const [message, expected] of [
    ['Failed to download image https://qq.example.invalid/?secret=test', '图片输入被拒绝'],
    ['This model maximum context length exceeded private-test-text', '上下文长度'],
    ['Too many images private-test-text', '图片数量'],
    ['Unsupported image input private-test-text', '不接受图像'],
    ['response_format json_object is not supported private-test-text', 'JSON 输出模式'],
    ['Invalid temperature private-test-text', '请求参数'],
  ]) {
    for (const body of [
      { code: 20015, message },
      { error: { code: 'invalid_request_error', message } },
    ]) {
      const hint = await providerErrorHint(new Response(JSON.stringify(body)));
      assert.ok(hint.includes(expected ?? ''));
      assert.equal(hint.includes('private-test-text'), false);
      assert.equal(hint.includes('secret=test'), false);
    }
  }
  assert.match(
    await providerErrorHint(
      new Response(JSON.stringify({ code: 20012, message: 'opaque-provider-error' })),
    ),
    /未返回可安全识别/,
  );
  assert.match(
    await providerErrorHint(
      new Response(JSON.stringify({ code: 20012, message: 'Model does not exist' })),
    ),
    /模型名称/,
  );
});

test('未知、超限或非 JSON 错误均不泄露响应内容', async () => {
  for (const body of [
    '<html>invalid-private-detail</html>',
    JSON.stringify({ error: { message: 'invalid-private-detail', code: 'invalid-secret-key' } }),
    'x'.repeat(65537),
  ]) {
    const hint = await providerErrorHint(new Response(body));
    assert.equal(hint.includes('invalid-private-detail'), false);
    assert.equal(hint.includes('invalid-secret-key'), false);
    assert.ok(hint.includes('供应商'));
  }
});
