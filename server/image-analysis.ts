import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  imageAnalysisResultSchema,
  imageSegmentSchema,
  type ImageAnalysis,
  type ImageEvidence,
  type ImageSegment,
} from '../shared/schema.js';
import {
  contextSchema,
  contextMessageSchema,
  ImageContextError,
  type ImageResolver,
} from './ai-context.js';
import {
  MAX_IMAGE_DOWNLOAD_BYTES,
  downloadQqImage,
  prepareImage,
  type PreparedImage,
} from './images.js';
import { ImageAnalysisCache, imageCachePolicy } from './image-cache.js';
import { beginProgress, type ProgressReporter } from './progress.js';

type ImageAnalyzer = (
  image: PreparedImage,
  signal: AbortSignal,
  report?: ProgressReporter,
) => Promise<z.output<typeof imageAnalysisResultSchema>>;
interface Dependencies {
  cache: ImageAnalysisCache;
  configuration: () => { account: string; model: string };
  resolveImage: ImageResolver;
  analyzeImage: ImageAnalyzer;
  download?: typeof downloadQqImage;
  prepare?: typeof prepareImage;
  now?: () => number;
  cleanupFailed?: () => void;
}
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
type ContextMessage = z.output<typeof contextMessageSchema>;

/** Engine owns request signals; Application owns this component's maintenance timer and shutdown. */
export class ImageAnalysisService {
  private readonly shutdown = new AbortController();
  private readonly pending = new Map<string, Promise<void>>();
  private timer: ReturnType<typeof setInterval> | undefined;
  constructor(private readonly dependencies: Dependencies) {}
  start(): void {
    if (this.timer || this.shutdown.signal.aborted) return;
    this.dependencies.cache.prune(this.now());
    this.timer = setInterval(() => {
      try {
        this.dependencies.cache.prune(this.now());
      } catch {
        if (this.dependencies.cleanupFailed) this.dependencies.cleanupFailed();
        else console.error('图片分析缓存定时清理失败');
      }
    }, imageCachePolicy.cleanupIntervalMs);
    this.timer.unref();
  }
  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.shutdown.abort();
  }
  private now(): number {
    return (this.dependencies.now ?? Date.now)();
  }
  async prepareContext(
    context: unknown,
    signal: AbortSignal,
    report?: ProgressReporter,
  ): Promise<{ context: unknown; imageEvidence: ImageEvidence[] }> {
    const requestSignal = AbortSignal.any([signal, this.shutdown.signal]);
    requestSignal.throwIfAborted();
    const parsed = contextSchema.parse(context);
    const count = [...(parsed.recentContext ?? []), ...(parsed.messages ?? [])].reduce(
      (total, message) =>
        total + (message.segments?.filter((segment) => segment.type === 'image').length ?? 0),
      0,
    );
    if (count > 100)
      throw new ImageContextError('本次上下文超过 100 张图片，未提交分析，也未推进本阶段进度。');
    if (!count) return { context, imageEvidence: [] };
    const imageEvidence: ImageEvidence[] = [];
    const transform = async (messages: ContextMessage[] | undefined) => {
      if (!messages) return undefined;
      const result: ContextMessage[] = [];
      for (const message of messages) {
        const segments: NonNullable<ContextMessage['segments']> = [];
        for (const [segmentIndex, segment] of (message.segments ?? []).entries()) {
          requestSignal.throwIfAborted();
          if (segment.type === 'text') {
            segments.push(segment);
            continue;
          }
          // Never trust an analysis supplied by an external/context caller.
          const image = imageSegmentSchema.parse(segment);
          const analysis = await this.resolve(message, segmentIndex, image, requestSignal, report);
          requestSignal.throwIfAborted();
          if (!analysis) {
            segments.push({ type: 'text', text: '[图片无法下载或超限，未分析]' });
            continue;
          }
          segments.push({ ...image, analysis });
          imageEvidence.push({
            messageId: message.id,
            conversationId: message.conversationId,
            segmentIndex,
            senderId: message.senderId,
            senderName: message.senderName,
            time: message.time,
            analysis,
          });
        }
        result.push({ ...message, segments: message.segments ? segments : undefined });
      }
      return result;
    };
    const recentContext = await transform(parsed.recentContext);
    const messages = await transform(parsed.messages);
    requestSignal.throwIfAborted();
    return { context: { ...parsed, recentContext, messages }, imageEvidence };
  }
  private async resolve(
    message: ContextMessage,
    segmentIndex: number,
    image: ImageSegment,
    signal: AbortSignal,
    report?: ProgressReporter,
  ): Promise<ImageAnalysis | undefined> {
    const { cache, configuration, resolveImage } = this.dependencies;
    const { account, model } = configuration();
    const aliasKey = digest(image.file ? `file:${image.file}` : `url:${image.url ?? ''}`);
    const occurrenceKey = digest(
      JSON.stringify([message.conversationId, message.id, segmentIndex, image.file, image.url]),
    );
    const known = cache.occurrence(account, occurrenceKey);
    const reused = known ? cache.get(account, known, this.now()) : undefined;
    if (reused) {
      const complete = beginProgress(report, 'tool', '复用已核验消息的图片分析');
      cache.save(account, reused, this.now(), occurrenceKey, aliasKey);
      complete('保留本次消息的发送者、时间和段落位置');
      return reused;
    }
    const candidate = cache.candidate(account, aliasKey);
    const resolved = beginProgress(report, 'tool', '读取并下载消息图片 URL');
    let url: string;
    let bytes: Buffer;
    try {
      url = await resolveImage(image, signal);
      signal.throwIfAborted();
      bytes = await (this.dependencies.download ?? downloadQqImage)(url, signal);
      signal.throwIfAborted();
      if (!bytes.length || bytes.length > MAX_IMAGE_DOWNLOAD_BYTES) throw new Error('图片下载超限');
      resolved();
    } catch {
      signal.throwIfAborted();
      resolved('图片下载不可用；保留占位符，未还原图片或调用其他下载接口');
      return undefined;
    }
    const hashed = beginProgress(report, 'tool', '核验下载文件 SHA-256');
    if (configuration().account !== account)
      throw new ImageContextError('图片分析期间账号发生变化，请重新检查。');
    const sha256 = digest(bytes);
    hashed(
      candidate === sha256
        ? 'QQ 标识候选已通过完整原文件指纹核验'
        : '已核验完整原文件指纹，QQ 标识不作为相同内容的证明',
    );
    const key = `${account}:${sha256}`;
    // Waiting callers own their own cancellation; they never abort another conversation's request.
    while (this.pending.has(key)) await this.wait(this.pending.get(key)!, signal);
    signal.throwIfAborted();
    const cached = cache.get(account, sha256, this.now());
    if (cached) {
      const complete = beginProgress(report, 'tool', '复用相同 SHA-256 的图片分析');
      cache.save(account, cached, this.now(), occurrenceKey, aliasKey);
      complete('图片不再提交模型，继续使用当前消息上下文');
      return cached;
    }
    let release = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.pending.set(key, pending);
    try {
      const prepared = await (this.dependencies.prepare ?? prepareImage)(
        url,
        signal,
        report,
        async () => bytes,
      );
      signal.throwIfAborted();
      const complete = beginProgress(report, 'ai', '首次图片独立分析');
      const result = imageAnalysisResultSchema.parse(
        await this.dependencies.analyzeImage(prepared, signal, report),
      );
      signal.throwIfAborted();
      if (configuration().account !== account)
        throw new ImageContextError('图片分析期间账号发生变化，请重新检查。');
      const analysis: ImageAnalysis = {
        ...result,
        sha256,
        model,
        scope: prepared.note ? 'first-frame' : 'static',
      };
      cache.save(account, analysis, this.now(), occurrenceKey, aliasKey);
      complete('已保存图片本身的分析，后续阶段使用文字描述');
      return analysis;
    } finally {
      this.pending.delete(key);
      release();
    }
  }
  private wait(task: Promise<void>, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const abort = () => {
        signal.removeEventListener('abort', abort);
        reject(signal.reason);
      };
      signal.addEventListener('abort', abort, { once: true });
      void task.then(() => {
        signal.removeEventListener('abort', abort);
        resolve();
      });
    });
  }
}
