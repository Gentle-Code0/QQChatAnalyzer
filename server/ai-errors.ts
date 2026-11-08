import { z } from 'zod';

const errorFields = z.object({
  code: z.union([z.string(), z.number()]).optional(),
  type: z.string().optional(),
  param: z.string().nullable().optional(),
  message: z.string().optional(),
});
const errorSchema = z.union([
  z.object({ error: errorFields }).transform((value) => value.error),
  errorFields,
]);
/** Classify upstream text locally. Never echo messages, unknown codes or parameters. */
export async function providerErrorHint(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '供应商未返回错误说明';
  const chunks: Uint8Array[] = [];
  let size = 0;
  let readable = true;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 65536) {
        readable = false;
        break;
      }
      chunks.push(part.value);
    }
  } catch {
    readable = false;
  } finally {
    try {
      await reader.cancel();
    } catch {
      readable = false;
    }
    reader.releaseLock();
  }
  if (!readable) return '供应商错误说明读取失败或超过大小限制';
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return '供应商未返回可识别的 JSON 错误说明';
  }
  const parsed = errorSchema.safeParse(raw);
  if (!parsed.success) return '供应商未返回可识别的错误类别';
  const text = Object.values(parsed.data).join(' ').toLowerCase();
  if (/model.{0,30}(not exist|not found|does not exist)/.test(text))
    return '模型名称不存在或当前渠道不可用';
  if (/context.{0,30}(length|window|limit)|maximum.{0,20}tokens|上下文.{0,10}(超|长)/.test(text))
    return '上下文长度超出模型限制';
  if (
    /too many images|max.{0,20}image|image.{0,20}(count|number).{0,20}(exceed|limit)|图片.{0,8}(数量|过多)/.test(
      text,
    )
  )
    return '图片数量超过供应商限制';
  if (/(not support|unsupported|不支持).{0,50}(image|vision|multimodal|图像|图片)/.test(text))
    return '当前模型或渠道不接受图像输入';
  if (/image|base64|图片|图像/.test(text))
    return '图片输入被拒绝（图片下载、格式、尺寸或图像参数不符合要求）';
  if (/response_format|json_object|json mode/.test(text)) return '供应商不接受当前 JSON 输出模式';
  if (
    /temperature|max_tokens|max_completion_tokens|unsupported.parameter|invalid.parameter/.test(
      text,
    )
  )
    return '请求参数与模型不兼容';
  return '供应商未返回可安全识别的错误类别';
}
