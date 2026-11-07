import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const identifierSchema = z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative()]).transform(String);
const segmentSchema = z.object({ type: z.string(), data: z.record(z.unknown()) });
const eventSchema = z.object({
  post_type: z.string().optional(), self_id: identifierSchema.optional(),
  message_type: z.enum(['private', 'group']), message_id: z.union([z.number().int(), z.string()]),
  user_id: identifierSchema, target_id: identifierSchema.optional(), group_id: identifierSchema.optional(),
  time: z.number().finite().nonnegative(),
  sender: z.object({ nickname: z.string().optional(), card: z.string().optional() }).optional(),
  message: z.union([z.string(), z.array(segmentSchema)]).optional(), raw_message: z.string().optional(),
});
export interface QqMessage {
  id: string; kind: 'private' | 'group'; peerId: string; senderId: string;
  senderName: string; text: string; time: number; mentionedSelf: boolean;
}
export interface BridgeOptions {
  url: string; token: string; selfQq: string;
  onMessage: (message: QqMessage) => void;
  onConnected: () => Promise<void>;
  onStatus: () => void;
}

export function validateEndpoint(value: string, protocols: string[]): URL {
  const endpoint = new URL(value);
  if (!protocols.includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash || endpoint.search) {
    throw new Error('地址协议无效，且地址不能包含账号、密码、查询参数或片段');
  }
  return endpoint;
}

/** Only these read actions can ever be written to the QQ socket. No generic action endpoint exists. */
export const readActions = ['get_login_info', 'get_friend_list', 'get_group_list', 'get_friend_msg_history', 'get_group_msg_history'] as const;
type ReadAction = typeof readActions[number];
interface PendingRequest { resolve: (data: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }

export function normalizeMessage(raw: unknown, selfQq: string, historyPeer?: string): QqMessage | undefined {
  const result = eventSchema.safeParse(raw);
  if (!result.success) return undefined;
  const event = result.data;
  if (event.self_id !== undefined && event.self_id !== selfQq) return undefined;
  if (event.post_type && !['message', 'message_sent'].includes(event.post_type)) return undefined;
  const peerId = event.message_type === 'group' ? event.group_id
    : historyPeer ?? (event.user_id === selfQq ? event.target_id : event.user_id);
  if (!peerId) return undefined;
  const segments = event.message;
  let mentionedSelf = false;
  let text = '';
  if (Array.isArray(segments)) {
    text = segments.map(segment => {
      if (segment.type === 'text') return typeof segment.data.text === 'string' ? segment.data.text : '';
      if (segment.type === 'at') {
        const target = String(segment.data.qq ?? '');
        if (target === selfQq) mentionedSelf = true;
        return ` @${target} `;
      }
      return `[${segment.type}]`;
    }).join('');
  } else text = segments ?? event.raw_message ?? '';
  if (!text.trim()) return undefined;
  return { id: String(event.message_id), kind: event.message_type, peerId, senderId: event.user_id,
    senderName: event.sender?.card || event.sender?.nickname || event.user_id,
    text: text.slice(0, 20000), time: event.time * 1000, mentionedSelf };
}

export class QqBridge {
  connected = false;
  status = '未连接';
  private socket: WebSocket | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly pending = new Map<string, PendingRequest>();
  private stopped = true;
  private retryDelay = 1000;
  constructor(private readonly options: BridgeOptions) {}

  start(): void {
    if (!this.stopped) return;
    validateEndpoint(this.options.url, ['ws:', 'wss:']);
    this.stopped = false;
    this.connect();
  }
  private connect(): void {
    if (this.stopped) return;
    this.status = '正在连接'; this.options.onStatus();
    const socket = new WebSocket(this.options.url, {
      headers: this.options.token ? { Authorization: `Bearer ${this.options.token}` } : {},
      maxPayload: 2 * 1024 * 1024, handshakeTimeout: 10000,
    });
    this.socket = socket;
    socket.on('open', () => {
      void this.handshake().catch(() => {
        this.status = '账号校验失败，请检查自身 QQ 号码和桥接配置';
        this.options.onStatus(); socket.close();
      });
    });
    socket.on('message', data => {
      try {
        const raw: unknown = JSON.parse(data.toString());
        const envelope = z.object({ echo: z.string().optional(), retcode: z.number().optional(), data: z.unknown() }).passthrough().safeParse(raw);
        if (envelope.success && envelope.data.echo) {
          const pending = this.pending.get(envelope.data.echo);
          if (!pending) return;
          clearTimeout(pending.timer); this.pending.delete(envelope.data.echo);
          if (envelope.data.retcode === 0) pending.resolve(envelope.data.data);
          else pending.reject(new Error(`QQ 只读接口失败 (${envelope.data.retcode ?? '未知返回码'})`));
          return;
        }
        if (!this.connected) return;
        const message = normalizeMessage(raw, this.options.selfQq);
        if (message) this.options.onMessage(message);
      } catch { this.status = '收到无效桥接数据'; this.options.onStatus(); }
    });
    socket.on('error', () => { this.status = '连接错误，请检查地址、Token 与网络'; this.options.onStatus(); });
    socket.on('close', () => {
      this.connected = false;
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('QQ 连接已断开')); }
      this.pending.clear();
      if (this.stopped) return;
      this.status = '连接断开，等待重连'; this.options.onStatus();
      this.reconnectTimer = setTimeout(() => this.connect(), this.retryDelay);
      this.retryDelay = Math.min(this.retryDelay * 2, 30000);
    });
  }
  private async handshake(): Promise<void> {
    const login = z.object({ user_id: identifierSchema }).parse(await this.request('get_login_info', {}));
    if (login.user_id !== this.options.selfQq) throw new Error('QQ 账号不匹配');
    this.connected = true; this.status = 'QQ 已连接 · 只读'; this.retryDelay = 1000; this.options.onStatus();
    await this.options.onConnected();
  }
  request(action: ReadAction, params: Record<string, string | number | boolean>): Promise<unknown> {
    if (!readActions.includes(action)) return Promise.reject(new Error('禁止非只读动作'));
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('QQ 尚未连接'));
    if (this.pending.size >= 100) return Promise.reject(new Error('桥接请求过多'));
    const echo = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(echo); reject(new Error('QQ 只读请求超时')); }, 15000);
      this.pending.set(echo, { resolve, reject, timer });
      socket.send(JSON.stringify({ action, params, echo }), error => {
        if (error) { clearTimeout(timer); this.pending.delete(echo); reject(new Error('QQ 请求发送失败')); }
      });
    });
  }
  async history(peerId: string, cursor = 0): Promise<{ messages: QqMessage[]; cursor: number; rawCount: number }> {
    const data = z.object({ messages: z.array(z.unknown()).max(500) }).parse(await this.request('get_friend_msg_history', {
      user_id: peerId, count: 100, message_id: cursor, reverse_order: true,
    }));
    const messages = data.messages.map(raw => normalizeMessage(raw, this.options.selfQq, peerId))
      .filter((item): item is QqMessage => item !== undefined).sort((left, right) => left.time - right.time);
    const oldest = data.messages[0];
    // Provider ordering is not assumed: use the chronologically oldest raw event as the page anchor.
    const anchors = data.messages.map(raw => z.object({ message_id: z.number().int(), time: z.number() }).safeParse(raw))
      .filter(item => item.success).map(item => item.data).sort((left, right) => left.time - right.time);
    void oldest;
    return { messages, cursor: anchors[0]?.message_id ?? cursor, rawCount: data.messages.length };
  }
  stop(): void {
    this.stopped = true; this.connected = false; this.status = '已断开';
    clearTimeout(this.reconnectTimer);
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('桥接已停止')); }
    this.pending.clear(); this.socket?.terminate(); this.socket = undefined;
  }
}
