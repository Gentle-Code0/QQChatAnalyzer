import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Store } from './store.js';
import { QqBridge, type QqMessage } from './bridge.js';
import { CompatibleAi, AiCallError } from './ai.js';
import { ImageAnalysisService } from './image-analysis.js';
import { AnalysisEngine } from './engine.js';
import {
  aiTestInputSchema,
  conversationSchema,
  type AiTestResult,
  type Contact,
  type Snapshot,
} from '../shared/schema.js';

/** Composition root owns bridge, imports, analysis and shutdown. Constructors perform no network IO. */
export class Application {
  readonly engine: AnalysisEngine;
  readonly images: ImageAnalysisService;
  bridge: QqBridge | undefined;
  private readonly imports = new Map<string, Promise<void>>();
  private closed = false;
  private readonly aiTests = new Map<AbortController, Promise<AiTestResult>>();
  constructor(readonly store: Store) {
    const ai = new CompatibleAi(
      () => ({ settings: store.settings, apiKey: store.secret('apiKey') }),
      async (image, signal) => {
        if (!this.bridge) throw new Error('QQ 尚未连接');
        return this.bridge.imageUrl(image, signal);
      },
    );
    this.images = new ImageAnalysisService({
      cache: store.imageCache,
      configuration: () => ({ account: store.settings.selfQq, model: store.settings.model }),
      resolveImage: async (image, signal) => {
        if (!this.bridge) throw new Error('QQ 尚未连接');
        return this.bridge.imageUrl(image, signal);
      },
      analyzeImage: (image, signal, report) => ai.analyzeImage(image, signal, report),
      cleanupFailed: () => console.error('图片分析缓存定时清理失败'),
    });
    this.engine = new AnalysisEngine(store, ai, () => {}, this.images);
  }

  testAi(input: unknown, signal: AbortSignal): Promise<AiTestResult> {
    const parsed = aiTestInputSchema.safeParse(input);
    if (!parsed.success)
      return Promise.resolve({
        ok: false,
        step: '配置校验',
        message: '请填写有效的 Base URL、模型名称和 API Key。',
      });
    if (this.closed || this.aiTests.size)
      return Promise.resolve({
        ok: false,
        step: '发送请求',
        message: this.closed ? '应用正在关闭。' : '已有 AI 测试正在进行，请稍后重试。',
      });
    const { baseUrl, model, apiKey } = parsed.data;
    const settings = { ...this.store.settings, baseUrl, model };
    const key = apiKey || this.store.secret('apiKey');
    const controller = new AbortController();
    const task = (async (): Promise<AiTestResult> => {
      try {
        await new CompatibleAi(() => ({ settings, apiKey: key })).call(
          '这是一条连接测试，不进行聊天分析。仅返回 JSON：{"ok":true}。',
          { connectionTest: true },
          z.object({ ok: z.literal(true) }),
          AbortSignal.any([signal, controller.signal]),
        );
        return { ok: true, message: '测试成功：AI 调用及 JSON 回传正常。' };
      } catch (error) {
        return {
          ok: false,
          step: error instanceof AiCallError ? error.step : '发送请求',
          message:
            error instanceof AiCallError
              ? error.message
              : '测试请求未能完成，请检查连接或稍后重试。',
        };
      }
    })().finally(() => this.aiTests.delete(controller));
    this.aiTests.set(controller, task);
    return task;
  }
  start(): void {
    this.images.start();
    this.reconnect();
    if (this.store.secret('apiKey')) {
      for (const conversation of this.store.conversations())
        this.engine.notify(conversation.id, false);
    }
  }
  snapshot(): Snapshot {
    return {
      self: this.store.self,
      settings: this.store.settings,
      contacts: this.store.contacts(),
      conversations: this.store
        .conversations()
        .map(({ summary: _summary, ...conversation }) => conversation),
      hasApiKey: Boolean(this.store.secret('apiKey')),
      hasQqToken: Boolean(this.store.secret('qqToken')),
      bridge: {
        connected: this.bridge?.connected ?? false,
        status: this.bridge?.status ?? '未配置 QQ 连接',
      },
    };
  }
  reconnect(): void {
    this.bridge?.stop();
    this.bridge = undefined;
    const settings = this.store.settings;
    if (this.closed || !settings.qqUrl || !settings.selfQq) return;
    this.bridge = new QqBridge({
      url: settings.qqUrl,
      token: this.store.secret('qqToken'),
      selfQq: settings.selfQq,
      onStatus: () => {},
      onMessage: (message) => this.receive(message, 'live'),
      onConnected: async () => {
        for (const contact of this.store.contacts()) void this.importHistory(contact.id);
      },
    });
    this.bridge.start();
  }
  ensureConversations(contact: Contact): void {
    for (const peer of [
      { kind: 'private' as const, peerId: contact.qq },
      ...contact.groupIds.map((peerId) => ({ kind: 'group' as const, peerId })),
    ]) {
      const id = `${contact.id}:${peer.kind}:${peer.peerId}`;
      if (!this.store.conversation(id))
        this.store.saveConversation(
          conversationSchema.parse({ id, contactId: contact.id, ...peer }),
        );
    }
  }
  receive(message: QqMessage, source: 'live' | 'history'): void {
    for (const contact of this.store.contacts()) {
      if (
        message.kind === 'private'
          ? contact.qq !== message.peerId
          : !contact.groupIds.includes(message.peerId)
      )
        continue;
      this.ensureConversations(contact);
      const id = `${contact.id}:${message.kind}:${message.peerId}`;
      const conversation = this.store.conversation(id)!;
      const added = this.store.addMessage({
        ...message,
        id: `${message.kind}:${message.peerId}:${message.id}`,
        conversationId: id,
        source,
        sequence: 0,
      });
      if (!added) continue;
      this.store.saveConversation({
        ...conversation,
        lastMessageAt: Math.max(conversation.lastMessageAt, message.time),
      });
      if (source === 'live') {
        if (this.store.secret('apiKey')) this.engine.notify(id);
        else
          this.store.saveConversation({
            ...this.store.conversation(id)!,
            status: '等待配置 AI API',
          });
      }
    }
  }
  importHistory(contactId: string): Promise<void> {
    const running = this.imports.get(contactId);
    if (running) return running;
    const task = this.runImport(contactId)
      .catch(() => {
        const contact = this.store.contact(contactId);
        if (contact)
          this.store.saveContact({
            ...contact,
            historyStatus: '历史读取失败；已读取部分保留，可重试',
          });
      })
      .finally(() => this.imports.delete(contactId));
    this.imports.set(contactId, task);
    return task;
  }
  private async runImport(contactId: string): Promise<void> {
    let contact = this.store.contact(contactId);
    const bridge = this.bridge;
    if (!contact || this.closed) return;
    if (!bridge?.connected) {
      this.store.saveContact({ ...contact, historyStatus: 'QQ 未连接，连接后自动读取历史' });
      return;
    }
    const conversationId = `${contact.id}:private:${contact.qq}`;
    // First import resumes the older-page checkpoint; completed imports refresh the recent gap.
    let cursor = contact.historyDone ? 0 : contact.historyCursor;
    let imported = 0;
    let exhausted = false;
    const pages = this.store.settings.historyPages;
    const refreshing = contact.historyDone;
    this.store.saveContact({ ...contact, historyStatus: '正在读取历史…' });
    for (
      let page = 0;
      page < pages && !this.closed && this.bridge === bridge && bridge.connected;
      page++
    ) {
      const batch = await bridge.history(contact.qq, cursor);
      const before = this.store.messageCount(conversationId);
      for (const message of batch.messages) this.receive(message, 'history');
      imported += batch.messages.length;
      contact = this.store.contact(contactId)!;
      const after = this.store.messageCount(conversationId);
      const reachedKnownHistory = refreshing && after - before < batch.messages.length;
      exhausted = batch.rawCount === 0 || batch.cursor === cursor || reachedKnownHistory;
      cursor = batch.cursor;
      this.store.saveContact({
        ...contact,
        historyCount: after,
        historyCursor: cursor,
        historyStatus: `已读取 ${imported} 条（读取范围受 QQ 接口限制）`,
      });
      if (exhausted) break;
    }
    contact = this.store.contact(contactId)!;
    if (this.closed || this.bridge !== bridge) return;
    this.store.saveContact({
      ...contact,
      historyDone: exhausted,
      historyStatus: !bridge.connected
        ? '连接中断；已读取部分保留，请重试'
        : exhausted
          ? '本次可读范围已读完（不保证完整历史）'
          : '达到本次分页上限，可能仍有缺口；点击继续读取',
    });
    if (this.store.secret('apiKey')) this.engine.notify(conversationId, false);
  }
  createId(): string {
    return randomUUID();
  }
  async stop(): Promise<void> {
    this.closed = true;
    this.images.stop();
    this.bridge?.stop();
    for (const controller of this.aiTests.keys()) controller.abort();
    await Promise.allSettled([
      ...this.aiTests.values(),
      ...this.imports.values(),
      this.engine.stop(),
    ]);
    this.store.close();
  }
}
