import { randomUUID } from 'node:crypto';
import { Store } from './store.js';
import { QqBridge, type QqMessage } from './bridge.js';
import { CompatibleAi } from './ai.js';
import { AnalysisEngine } from './engine.js';
import { conversationSchema, type Contact, type Snapshot } from '../shared/schema.js';

/** Composition root owns bridge, imports, analysis and shutdown. Constructors perform no network IO. */
export class Application {
  readonly engine: AnalysisEngine;
  bridge: QqBridge | undefined;
  private readonly imports = new Map<string, Promise<void>>();
  private closed = false;
  constructor(readonly store: Store) {
    this.engine = new AnalysisEngine(
      store,
      new CompatibleAi(
        () => ({ settings: store.settings, apiKey: store.secret('apiKey') }),
        async (image, signal) => {
          if (!this.bridge) throw new Error('QQ 尚未连接');
          return this.bridge.imageUrl(image, signal);
        },
      ),
      () => {},
    );
  }
  start(): void {
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
      conversations: this.store.conversations(),
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
    this.bridge?.stop();
    await Promise.allSettled([...this.imports.values(), this.engine.stop()]);
    this.store.close();
  }
}
