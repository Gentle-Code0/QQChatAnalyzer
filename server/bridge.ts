import type { BridgeProvider, Message } from '../shared/schema.js';
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { imageSegmentSchema, type ImageSegment, type MessageSegment } from '../shared/schema.js';

const identifierSchema = z
  .union([z.string().regex(/^\d+$/), z.number().int().nonnegative()])
  .transform(String);
const segmentSchema = z.object({ type: z.string(), data: z.record(z.unknown()) });
const eventSchema = z.object({
  post_type: z.string().optional(),
  self_id: identifierSchema.optional(),
  message_type: z.enum(['private', 'group']),
  message_seq: z.union([z.number().int(), z.string()]).optional(),
  real_seq: z.union([z.number().int(), z.string()]).optional(),
  message_id: z.union([z.number().int(), z.string()]),
  user_id: identifierSchema,
  target_id: identifierSchema.optional(),
  group_id: identifierSchema.optional(),
  time: z.number().finite().nonnegative(),
  sender: z.object({ nickname: z.string().optional(), card: z.string().optional() }).optional(),
  message: z.union([z.string(), z.array(segmentSchema).max(512)]).optional(),
  raw_message: z.string().optional(),
});
export interface QqMessage {
  id: string;
  kind: 'private' | 'group';
  peerId: string;
  senderId: string;
  senderName: string;
  text: string;
  segments?: MessageSegment[];
  time: number;
  mentionedSelf: boolean;
  identities?: Message['identities'];
}
export interface BridgeOptions {
  provider?: BridgeProvider;
  url: string;
  token: string;
  selfQq: string;
  onMessage: (message: QqMessage) => void;
  onConnected: () => Promise<void>;
  onDisconnected?: () => void;
  onStatus: () => void;
}

export function validateEndpoint(value: string, protocols: string[]): URL {
  const endpoint = new URL(value);
  if (
    !protocols.includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.hash ||
    endpoint.search
  ) {
    throw new Error('地址协议无效，且地址不能包含账号、密码、查询参数或片段');
  }
  return endpoint;
}

/** Only these read actions can ever be written to the QQ socket. No generic action endpoint exists. */
export const readActions = [
  'get_login_info',
  'get_friend_list',
  'get_group_list',
  'get_friend_msg_history',
  'get_group_msg_history',
  'get_image',
] as const;
type ReadAction = (typeof readActions)[number];
interface PendingRequest {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}

function decodeCq(value: string): string {
  return value
    .replaceAll('&#91;', '[')
    .replaceAll('&#93;', ']')
    .replaceAll('&#44;', ',')
    .replaceAll('&amp;', '&');
}
function parseCqMessage(value: string): z.infer<typeof segmentSchema>[] {
  const segments: z.infer<typeof segmentSchema>[] = [];
  let offset = 0;
  for (const match of value.matchAll(/\[CQ:([a-zA-Z0-9_]+)((?:,[^\]]*)?)\]/g)) {
    if (match.index > offset)
      segments.push({ type: 'text', data: { text: decodeCq(value.slice(offset, match.index)) } });
    const data: Record<string, unknown> = {};
    for (const entry of (match[2] ?? '').split(',').slice(1)) {
      const separator = entry.indexOf('=');
      if (separator > 0) data[entry.slice(0, separator)] = decodeCq(entry.slice(separator + 1));
    }
    segments.push({ type: match[1] ?? '', data });
    offset = match.index + match[0].length;
    if (segments.length > 510) throw new Error('QQ 消息段超过上限');
  }
  if (offset < value.length)
    segments.push({ type: 'text', data: { text: decodeCq(value.slice(offset)) } });
  return segments;
}

export function normalizeMessage(
  raw: unknown,
  selfQq: string,
  historyPeer?: string,
  provider: BridgeProvider = 'snowluma',
): QqMessage | undefined {
  const result = eventSchema.safeParse(raw);
  if (!result.success) return undefined;
  const event = result.data;
  if (event.self_id !== undefined && event.self_id !== selfQq) return undefined;
  if (event.post_type && !['message', 'message_sent'].includes(event.post_type)) return undefined;
  const explicitPrivatePeer = event.user_id === selfQq ? event.target_id : event.user_id;
  if (
    event.message_type === 'private' &&
    historyPeer &&
    explicitPrivatePeer &&
    explicitPrivatePeer !== historyPeer
  )
    return undefined;
  const peerId =
    event.message_type === 'group'
      ? event.group_id
      : (historyPeer ?? (event.user_id === selfQq ? event.target_id : event.user_id));
  if (!peerId) return undefined;
  const upstream = Array.isArray(event.message)
    ? event.message
    : parseCqMessage(event.message ?? event.raw_message ?? '');
  let mentionedSelf = false;
  const segments: MessageSegment[] = [];
  let text = '';
  for (const segment of upstream) {
    let part: MessageSegment;
    if (segment.type === 'image' || segment.type === 'mface') {
      part = imageSegmentSchema.parse({
        type: 'image',
        file:
          typeof segment.data.file === 'string'
            ? segment.data.file
            : typeof segment.data.file_id === 'string'
              ? segment.data.file_id
              : undefined,
        url: typeof segment.data.url === 'string' ? segment.data.url : undefined,
        summary:
          typeof segment.data.summary === 'string' ? segment.data.summary.slice(0, 300) : undefined,
      });
    } else {
      let value = `[${segment.type}]`;
      if (segment.type === 'text')
        value = typeof segment.data.text === 'string' ? segment.data.text : '';
      if (segment.type === 'at') {
        const target = String(segment.data.qq ?? '');
        if (target === selfQq) mentionedSelf = true;
        value = ` @${target} `;
      }
      if (segment.type === 'face') value = `[QQ表情 ${String(segment.data.id ?? '')}]`;
      part = { type: 'text', text: value.slice(0, Math.max(0, 20000 - text.length)) };
    }
    segments.push(part);
    text += part.type === 'text' ? part.text : '[图片]';
  }
  if (!text.trim()) return undefined;
  return {
    identities: [
      {
        provider,
        account: selfQq,
        id: String(event.message_id),
        rawSequence: event.message_seq === undefined ? undefined : String(event.message_seq),
        groupSequence:
          event.message_type === 'group'
            ? String(provider === 'napcat' ? (event.real_seq ?? '') : (event.message_seq ?? '')) ||
              undefined
            : undefined,
      },
    ],
    id: String(event.message_id),
    kind: event.message_type,
    peerId,
    senderId: event.user_id,
    senderName: event.sender?.card || event.sender?.nickname || event.user_id,
    text: text.slice(0, 20000),
    segments: segments.some((part) => part.type === 'image') ? segments : undefined,
    time: event.time * 1000,
    mentionedSelf,
  };
}

export class BridgeRequestError extends Error {
  constructor(readonly providerMessage: string) {
    super('QQ 只读接口失败');
  }
}
export class QqBridge {
  get provider(): BridgeProvider {
    return this.options.provider ?? 'snowluma';
  }
  connected = false;
  status = '未连接';
  private receptionCounts = { incoming: 0, selfReceived: 0, selfAccepted: 0 };
  get reception() {
    return { ...this.receptionCounts };
  }
  private socket: WebSocket | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly pending = new Map<string, PendingRequest>();
  private stopped = true;
  private retryDelay = 1000;
  private epoch = 0;
  private validating: Promise<void> | undefined;
  constructor(private readonly options: BridgeOptions) {}

  start(): void {
    if (!this.stopped) return;
    validateEndpoint(this.options.url, ['ws:', 'wss:']);
    this.stopped = false;
    this.connect();
  }
  private connect(): void {
    if (this.stopped) return;
    this.receptionCounts = { incoming: 0, selfReceived: 0, selfAccepted: 0 };
    this.status = '正在连接';
    this.options.onStatus();
    const socket = new WebSocket(this.options.url, {
      headers: this.options.token ? { Authorization: `Bearer ${this.options.token}` } : {},
      maxPayload: 2 * 1024 * 1024,
      handshakeTimeout: 10000,
    });
    this.socket = socket;
    socket.on('open', () => this.validateConnection(socket));
    socket.on('message', (data) => {
      if (this.socket !== socket || this.stopped) return;
      try {
        const raw: unknown = JSON.parse(data.toString());
        const envelope = z
          .object({
            echo: z.string().optional(),
            retcode: z.number().optional(),
            message: z.string().optional(),
            wording: z.string().optional(),
            data: z.unknown(),
          })
          .passthrough()
          .safeParse(raw);
        if (envelope.success && envelope.data.echo) {
          const pending = this.pending.get(envelope.data.echo);
          if (!pending) return;
          pending.cleanup();
          this.pending.delete(envelope.data.echo);
          if (envelope.data.retcode === 0) pending.resolve(envelope.data.data);
          else
            pending.reject(
              new BridgeRequestError(envelope.data.message || envelope.data.wording || ''),
            );
          return;
        }
        const notice = z
          .object({
            self_id: identifierSchema,
            post_type: z.string(),
            notice_type: z.string().optional(),
            sub_type: z.string().optional(),
            status: z.object({ online: z.boolean().optional() }).optional(),
          })
          .safeParse(raw);
        if (notice.success && notice.data.self_id === this.options.selfQq) {
          const value = notice.data;
          const accountStatus = value.post_type === 'notice' && value.notice_type === 'bot_status';
          const heartbeat = value.post_type === 'meta_event';
          if (
            (accountStatus && value.sub_type === 'offline') ||
            (value.post_type === 'notice' && value.notice_type === 'bot_offline') ||
            (heartbeat && value.status?.online === false)
          ) {
            this.disconnected('QQ 账号离线，等待恢复');
            return;
          }
          if (
            !this.connected &&
            ((accountStatus && value.sub_type === 'online') ||
              (heartbeat && value.status?.online === true))
          ) {
            this.validateConnection(socket);
            return;
          }
        }
        if (!this.connected) return;
        // Count only events for the verified account. Never retain payloads in diagnostics.
        const identity = z
          .object({
            self_id: identifierSchema,
            post_type: z.enum(['message', 'message_sent']),
            user_id: identifierSchema.optional(),
          })
          .safeParse(raw);
        const fromSelf =
          identity.success &&
          identity.data.self_id === this.options.selfQq &&
          (identity.data.post_type === 'message_sent' ||
            identity.data.user_id === this.options.selfQq);
        if (fromSelf) this.receptionCounts.selfReceived++;
        const message = normalizeMessage(raw, this.options.selfQq, undefined, this.provider);
        if (message) {
          if (fromSelf) this.receptionCounts.selfAccepted++;
          else if (message.senderId !== this.options.selfQq) this.receptionCounts.incoming++;
          this.options.onMessage(message);
        }
      } catch {
        this.status = '收到无效桥接数据';
        this.options.onStatus();
      }
    });
    socket.on('error', () => {
      if (this.socket !== socket || this.stopped) return;
      this.status = '连接错误，请检查地址、Token 与网络';
      this.options.onStatus();
    });
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.disconnected('连接断开，等待重连');
      if (this.stopped) return;
      this.status = '连接断开，等待重连';
      this.options.onStatus();
      this.reconnectTimer = setTimeout(() => this.connect(), this.retryDelay);
      this.retryDelay = Math.min(this.retryDelay * 2, 30000);
    });
  }
  private disconnected(status: string): void {
    const notify = this.connected || this.validating !== undefined;
    this.epoch++;
    this.validating = undefined;
    this.connected = false;
    this.status = status;
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(new Error(this.stopped ? '桥接已停止' : 'QQ 连接或账号已离线'));
    }
    this.pending.clear();
    if (notify) this.options.onDisconnected?.();
    this.options.onStatus();
  }
  private validateConnection(socket: WebSocket): void {
    if (this.stopped || this.socket !== socket || this.validating || this.connected) return;
    const epoch = ++this.epoch;
    const task = this.handshake(socket, epoch)
      .catch(() => {
        if (this.stopped || this.socket !== socket || this.epoch !== epoch) return;
        this.status = '账号校验失败，请检查自身 QQ 号码和桥接配置';
        this.options.onStatus();
        socket.close();
      })
      .finally(() => {
        if (this.validating === task) this.validating = undefined;
      });
    this.validating = task;
  }
  private async handshake(socket: WebSocket, epoch: number): Promise<void> {
    const login = z
      .object({ user_id: identifierSchema })
      .parse(await this.request('get_login_info', {}));
    if (
      this.stopped ||
      this.socket !== socket ||
      this.epoch !== epoch ||
      socket.readyState !== WebSocket.OPEN
    )
      return;
    if (login.user_id !== this.options.selfQq) throw new Error('QQ 账号不匹配');
    this.connected = true;
    this.status = 'QQ 已连接 · 只读';
    this.retryDelay = 1000;
    this.options.onStatus();
    await this.options.onConnected();
  }
  request(
    action: ReadAction,
    params: Record<string, string | number | boolean>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(new Error('QQ 请求已取消'));
    if (!readActions.includes(action)) return Promise.reject(new Error('禁止非只读动作'));
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error('QQ 尚未连接'));
    if (this.pending.size >= 100) return Promise.reject(new Error('桥接请求过多'));
    const echo = randomUUID();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        this.pending.delete(echo);
      };
      const cancel = () => {
        cleanup();
        reject(new Error('QQ 请求已取消'));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('QQ 只读请求超时'));
      }, 15000);
      this.pending.set(echo, { resolve, reject, cleanup });
      signal?.addEventListener('abort', cancel, { once: true });
      socket.send(JSON.stringify({ action, params, echo }), (error) => {
        if (error) {
          cleanup();
          reject(new Error('QQ 请求发送失败'));
        }
      });
    });
  }
  async imageUrl(image: ImageSegment, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    if (!image.url) throw new Error('消息图片没有可下载 URL');
    const url = new URL(image.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      throw new Error('消息图片 URL 无效');
    return image.url;
  }

  async history(
    peerId: string,
    cursor = 0,
    kind: 'private' | 'group' = 'private',
    signal?: AbortSignal,
    count = 100,
  ): Promise<{ messages: QqMessage[]; cursor: number; rawCount: number; unavailable?: boolean }> {
    let response: unknown;
    try {
      response = await this.request(
        kind === 'private' ? 'get_friend_msg_history' : 'get_group_msg_history',
        {
          ...(kind === 'private' ? { user_id: peerId } : { group_id: peerId }),
          count: Math.max(1, Math.min(100, count)),
          ...(this.provider === 'napcat'
            ? { message_seq: String(cursor) }
            : { message_id: cursor }),
          reverse_order: true,
        },
        signal,
      );
    } catch (error) {
      // An unreadable anchor does not prove that all history was read.
      if (
        this.provider === 'napcat' &&
        error instanceof BridgeRequestError &&
        error.providerMessage === '消息' + cursor + '不存在'
      )
        return { messages: [], cursor, rawCount: 0, unavailable: true };
      throw error;
    }
    const data = z
      .object({
        messages: z
          .array(z.unknown())
          .max(this.provider === 'napcat' ? Math.max(1, Math.min(100, count)) : 500),
      })
      .parse(response);
    for (const raw of data.messages) {
      const parsed = eventSchema.safeParse(raw);
      if (!parsed.success) continue;
      const event = parsed.data;
      const explicitPeer =
        kind === 'group'
          ? event.group_id
          : event.user_id === this.options.selfQq
            ? event.target_id
            : event.user_id;
      if (
        (event.self_id !== undefined && event.self_id !== this.options.selfQq) ||
        event.message_type !== kind ||
        (explicitPeer !== undefined && explicitPeer !== peerId)
      )
        throw new Error('历史消息的账号或会话身份不匹配，未接收该页');
    }
    const messages = data.messages
      .map((raw) =>
        normalizeMessage(
          raw,
          this.options.selfQq,
          kind === 'private' ? peerId : undefined,
          this.provider,
        ),
      )
      .filter(
        (item): item is QqMessage =>
          item !== undefined && item.kind === kind && item.peerId === peerId,
      )
      .sort((left, right) => left.time - right.time);
    // Provider ordering is not assumed: use the chronologically oldest raw event as the page anchor.
    const anchors = data.messages
      .map((raw) => z.object({ message_id: z.number().int(), time: z.number() }).safeParse(raw))
      .filter((item) => item.success)
      .map((item) => item.data)
      .sort((left, right) => left.time - right.time);
    return { messages, cursor: anchors[0]?.message_id ?? cursor, rawCount: data.messages.length };
  }
  stop(): void {
    this.stopped = true;
    this.disconnected('已断开');
    this.status = '已断开';
    clearTimeout(this.reconnectTimer);
    this.socket?.terminate();
    this.socket = undefined;
  }
}
