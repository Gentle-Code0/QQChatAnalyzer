import { historySyncSchema, type Conversation, type HistorySync } from '../shared/schema.js';
import { Store } from './store.js';
import { QqBridge, type QqMessage } from './bridge.js';

export const historySyncTiming = { continuationMs: 1000, retryMs: 2000, maxRetries: 3 };
interface Dependencies {
  store: Store;
  bridge: () => QqBridge | undefined;
  ensureConversations: (contactId: string) => void;
  receive: (message: QqMessage) => string[];
  onStarting: (id: string) => void;
  onImported: (id: string) => void;
  onSettled: (id: string) => void;
}
/** Serial, bounded page batches. Initial backfill and reconnect gaps never share a cursor. */
export class HistorySynchronizer {
  private epoch = 0;
  private closed = false;
  private tail: Promise<void> = Promise.resolve();
  private readonly jobs = new Map<string, Promise<void>>();
  private readonly tasks = new Set<Promise<void>>();
  private readonly controllers = new Set<AbortController>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly retries = new Map<string, number>();
  constructor(private readonly dependencies: Dependencies) {}
  private targets(contactId?: string): Conversation[] {
    const { store } = this.dependencies;
    const result: Conversation[] = [];
    for (const contact of store.contacts()) {
      if (contactId && contact.id !== contactId) continue;
      this.dependencies.ensureConversations(contact.id);
      for (const peer of [
        { kind: 'private', id: contact.qq },
        ...contact.groupIds.map((id) => ({ kind: 'group', id })),
      ]) {
        const conversation = store.conversation(`${contact.id}:${peer.kind}:${peer.id}`);
        if (conversation) result.push(conversation);
      }
    }
    return result;
  }
  private watched(id: string): Conversation | undefined {
    const { store } = this.dependencies;
    const conversation = store.conversation(id);
    const contact = conversation && store.contact(conversation.contactId);
    if (!conversation || !contact) return;
    return conversation.kind === 'private'
      ? conversation.peerId === contact.qq
        ? conversation
        : undefined
      : contact.groupIds.includes(conversation.peerId)
        ? conversation
        : undefined;
  }
  private state(conversation: Conversation): HistorySync {
    const { store } = this.dependencies;
    const existing = store.historySync(conversation.id);
    const accountId = store.settings.selfQq;
    if (existing?.accountId === accountId) return existing;
    const legacy =
      conversation.kind === 'private' ? store.contact(conversation.contactId) : undefined;
    return historySyncSchema.parse({
      conversationId: conversation.id,
      accountId,
      initialCursor: legacy?.historyCursor ?? 0,
      initialDone: legacy?.historyDone ?? false,
    });
  }
  private recover(conversation: Conversation, state: HistorySync): void {
    const latest = this.dependencies.store.recentMessages(conversation.id, 1).at(-1);
    this.dependencies.store.saveHistorySync({
      ...state,
      recoveryPending: true,
      recoveryCursor: 0,
      recoveryVisited: [],
      boundaryId: state.recoveryPending ? state.boundaryId : (latest?.id ?? ''),
    });
  }
  connected(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.invalidate();
    // Pin every old boundary before any newly arrived live event can become an accidental boundary.
    const targets = this.targets();
    for (const conversation of targets) {
      const state = this.state(conversation);
      if (
        state.recoveryPending ||
        state.initialDone ||
        this.dependencies.store.messageCount(conversation.id) > 0
      )
        this.recover(conversation, state);
      else this.dependencies.store.saveHistorySync(state);
    }
    return Promise.all(targets.map((conversation) => this.enqueue(conversation.id, true))).then(
      () => {},
    );
  }
  disconnected(): void {
    if (this.closed) return;
    this.invalidate();
    for (const conversation of this.targets())
      this.status(conversation.id, 'QQ 离线；连接恢复后自动补读，已读进度保留');
  }
  private invalidate(): void {
    this.epoch++;
    for (const controller of this.controllers) controller.abort();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.jobs.clear();
    this.retries.clear();
  }
  isSyncing(id: string): boolean {
    return this.jobs.has(id) || this.timers.has(id);
  }
  importContact(contactId: string): Promise<void> {
    if (this.closed) return Promise.resolve();
    const bridge = this.dependencies.bridge();
    const targets = this.targets(contactId);
    if (!bridge?.connected) {
      for (const conversation of targets)
        this.status(conversation.id, 'QQ 未连接；连接后自动读取历史');
      return Promise.resolve();
    }
    for (const conversation of targets) {
      if (this.isSyncing(conversation.id)) continue;
      const state = this.state(conversation);
      if (state.initialDone && !state.recoveryPending) this.recover(conversation, state);
      else this.dependencies.store.saveHistorySync({ ...state, recoveryVisited: [] });
    }
    return Promise.all(targets.map((conversation) => this.enqueue(conversation.id, false))).then(
      () => {},
    );
  }
  private status(id: string, text: string): void {
    const { store } = this.dependencies;
    const conversation = store.conversation(id);
    if (!conversation) return;
    store.saveConversation({ ...conversation, historyStatus: text });
    if (conversation.kind === 'private') {
      const contact = store.contact(conversation.contactId);
      if (contact) {
        const state = this.state(conversation);
        store.saveContact({
          ...contact,
          historyStatus: text,
          historyCount: store.messageCount(id),
          historyCursor: state.initialCursor,
          historyDone: state.initialDone,
        });
      }
    }
  }
  private enqueue(id: string, automatic: boolean): Promise<void> {
    const existing = this.jobs.get(id);
    if (existing) return existing;
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    const epoch = this.epoch;
    const affected = new Set([id]);
    const task = this.tail
      .then(async () => {
        if (!this.closed && epoch === this.epoch) await this.run(id, automatic, epoch, affected);
      })
      .catch(() => {
        console.error('历史补读状态处理失败；已保存消息与进度保留');
      })
      .finally(() => {
        this.tasks.delete(task);
        if (this.jobs.get(id) === task) this.jobs.delete(id);
        if (!this.closed && epoch === this.epoch && this.dependencies.bridge()?.connected)
          for (const conversationId of affected)
            if (!this.isSyncing(conversationId)) {
              try {
                this.dependencies.onSettled(conversationId);
              } catch {
                console.error('历史补读后的分析调度失败；待处理水位保留');
              }
            }
      });
    this.tail = task;
    this.jobs.set(id, task);
    this.tasks.add(task);
    this.dependencies.onStarting(id);
    return task;
  }
  private continue(id: string, delay: number): void {
    clearTimeout(this.timers.get(id));
    const epoch = this.epoch;
    const timer = setTimeout(() => {
      this.timers.delete(id);
      if (!this.closed && epoch === this.epoch && this.dependencies.bridge()?.connected)
        void this.enqueue(id, true);
    }, delay);
    timer.unref();
    this.timers.set(id, timer);
  }
  private async run(
    id: string,
    automatic: boolean,
    epoch: number,
    affected: Set<string>,
  ): Promise<void> {
    const { store } = this.dependencies;
    const conversation = this.watched(id),
      bridge = this.dependencies.bridge();
    if (!conversation || !bridge?.connected) return;
    const controller = new AbortController();
    this.controllers.add(controller);
    let state = this.state(conversation);
    const recovering = state.recoveryPending;
    let cursor = recovering ? state.recoveryCursor : state.initialCursor;
    const valid = () =>
      !controller.signal.aborted &&
      !this.closed &&
      epoch === this.epoch &&
      this.dependencies.bridge() === bridge &&
      bridge.connected &&
      store.settings.selfQq === state.accountId &&
      !!this.watched(id);
    const visited = new Set<number>(recovering ? state.recoveryVisited : []);
    this.status(id, recovering ? '正在自动补读断线缺口…' : '正在读取历史…');
    try {
      for (let page = 0; page < store.settings.historyPages && valid(); page++) {
        if (visited.has(cursor)) {
          this.status(id, '分页锚点出现循环，可能仍有缺口；重连或点击重试');
          return;
        }
        visited.add(cursor);
        const batch = await bridge.history(
          conversation.peerId,
          cursor,
          conversation.kind,
          controller.signal,
        );
        if (!valid()) return;
        const imported = new Set<string>();
        for (const message of batch.messages)
          for (const conversationId of this.dependencies.receive(message)) {
            imported.add(conversationId);
            affected.add(conversationId);
          }
        for (const conversationId of imported) this.dependencies.onImported(conversationId);
        const matched =
          recovering &&
          !!state.boundaryId &&
          batch.messages.some(
            (message) => `${message.kind}:${message.peerId}:${message.id}` === state.boundaryId,
          );
        const ended = batch.rawCount === 0;
        const stalled = !ended && (batch.cursor === cursor || visited.has(batch.cursor));
        state = recovering
          ? {
              ...state,
              recoveryCursor: batch.cursor,
              recoveryVisited: [...visited].slice(-1000),
              recoveryPending: !(matched || (ended && !state.boundaryId)),
            }
          : { ...state, initialCursor: batch.cursor, initialDone: ended };
        store.saveHistorySync(state);
        cursor = batch.cursor;
        this.retries.delete(id);
        if (matched) {
          this.status(
            id,
            `断线缺口已补读到原消息锚点${state.initialDone ? '' : '；更早历史仍可继续读取'}`,
          );
          return;
        }
        if (ended || stalled) {
          this.status(
            id,
            recovering && state.boundaryId
              ? '已到本次接口可读范围或分页无法前进，尚未找到原锚点，可能仍有缺口；重连或点击重试'
              : ended
                ? '本次可读范围已读完（不保证完整历史）'
                : '分页锚点未前进，可能仍有缺口；点击重试',
          );
          return;
        }
      }
      if (!valid()) return;
      if (recovering && automatic) {
        this.status(id, '达到本批分页上限；已保存补读进度，将自动继续');
        this.continue(id, historySyncTiming.continuationMs);
      } else this.status(id, '达到本次分页上限，可能仍有缺口；点击继续读取');
    } catch {
      if (!valid()) return;
      const retries = (this.retries.get(id) ?? 0) + 1;
      this.retries.set(id, retries);
      if (automatic && retries <= historySyncTiming.maxRetries) {
        this.status(id, '历史补读失败；已读取部分和游标保留，将自动重试');
        this.continue(id, historySyncTiming.retryMs * retries);
      } else this.status(id, '历史读取失败；已读取部分和游标保留，重连或点击重试');
    } finally {
      this.controllers.delete(controller);
    }
  }
  async stop(): Promise<void> {
    this.closed = true;
    this.invalidate();
    await Promise.allSettled([...this.tasks]);
  }
}
