import { z } from 'zod';
import { beginProgress, type ProgressReporter } from './progress.js';
import {
  messageSchema,
  messageSegmentSchema,
  imageSegmentSchema,
  imageAnalysisSchema,
  type ImageSegment,
} from '../shared/schema.js';

export class ImageContextError extends Error {}
export type ImageResolver = (image: ImageSegment, signal: AbortSignal) => Promise<string>;
export type ContentPart =
  { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

const analyzedImageSegmentSchema = imageSegmentSchema.extend({
  analysis: imageAnalysisSchema.optional(),
});
export const contextMessageSchema = messageSchema.extend({
  segments: z
    .array(
      z.discriminatedUnion('type', [messageSegmentSchema.options[0], analyzedImageSegmentSchema]),
    )
    .max(512)
    .optional(),
  senderRole: z.enum(['self', 'contact', 'other']).optional(),
});
export const contextSchema = z
  .object({
    recentContext: z.array(contextMessageSchema).max(200).optional(),
    messages: z.array(contextMessageSchema).max(200).optional(),
  })
  .passthrough();

function imageUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ImageContextError('图片地址无效，请检查 QQ 图片接口后重新检查。');
  }
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash ||
    value.length > 8192
  ) {
    throw new ImageContextError('图片地址必须是无嵌入凭据的 HTTP(S) 地址。');
  }
  return url.href;
}

/** Keep each image between its own preceding/following text, within its attributed message. */
export async function buildContextContent(
  context: unknown,
  resolveImage: ImageResolver,
  signal: AbortSignal,
  report?: ProgressReporter,
): Promise<string | ContentPart[]> {
  signal.throwIfAborted();
  const { recentContext, messages, ...metadata } = contextSchema.parse(context);
  const groups = [
    { section: 'recentContext', messages: recentContext ?? [] },
    { section: 'messages', messages: messages ?? [] },
  ];
  const entries = groups
    .flatMap((group) => group.messages.map((message) => ({ section: group.section, message })))
    .sort(
      (left, right) =>
        left.message.time - right.message.time || left.message.sequence - right.message.sequence,
    );
  const imageCount = entries
    .map((entry) => entry.message)
    .reduce(
      (total, message) =>
        total + (message.segments?.filter((part) => part.type === 'image').length ?? 0),
      0,
    );
  if (!imageCount) return JSON.stringify(context);
  if (imageCount > 100)
    throw new ImageContextError('本次上下文超过 100 张图片，未提交分析，也未推进本阶段进度。');
  const content: ContentPart[] = [{ type: 'text', text: JSON.stringify({ context: metadata }) }];
  // Resolve once per request, but emit every occurrence in its original place.
  const resolved = new Map<string, string>();
  for (const { section, message } of entries) {
    const { text, segments, ...attribution } = message;
    content.push({
      type: 'text',
      text: JSON.stringify({ section, message: attribution }),
    });
    const parts = segments?.length ? segments : [{ type: 'text' as const, text }];
    for (const [index, part] of parts.entries()) {
      signal.throwIfAborted();
      if (part.type === 'text') {
        content.push({ type: 'text', text: JSON.stringify({ segment: index + 1, ...part }) });
        continue;
      }
      if (part.analysis) {
        content.push({
          type: 'text',
          text: JSON.stringify({
            segment: index + 1,
            type: 'image',
            imageAnalysis: part.analysis,
            interpretation: '图片本身的独立分析，不代表本次发送的意图；须结合当前消息上下文判断。',
          }),
        });
        continue;
      }
      const key = JSON.stringify(part);
      let url = resolved.get(key);
      if (!url) {
        try {
          const complete = beginProgress(
            report,
            'tool',
            part.file ? 'get_image · 读取图片地址' : '读取消息图片地址',
          );
          url = imageUrl(await resolveImage(part, signal));
          signal.throwIfAborted();
          complete('图片地址已校验，保持原消息中的位置');
        } catch (error) {
          signal.throwIfAborted();
          if (error instanceof ImageContextError) throw error;
          throw new ImageContextError(
            '无法读取消息图片，请检查 QQ 连接或图片是否过期，然后重新检查。',
          );
        }
        resolved.set(key, url);
      }
      signal.throwIfAborted();
      content.push({
        type: 'text',
        text: JSON.stringify({ segment: index + 1, type: 'image', summary: part.summary }),
      });
      content.push({ type: 'image_url', image_url: { url } });
    }
    content.push({ type: 'text', text: JSON.stringify({ endMessage: message.id }) });
  }
  return content;
}
