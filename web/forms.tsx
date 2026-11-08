import { useState, type FormEvent, type ReactNode } from 'react';
import { z } from 'zod';
import type { Contact, Snapshot } from '../shared/schema';
import { api, send, splitList } from './api';

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
export function Form({
  children,
  save,
  label = '保存设置',
}: {
  children: ReactNode;
  save: () => Promise<void>;
  label?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    try {
      await save();
      setMessage('已保存');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={(event) => void submit(event)}>
      {children}
      <div className="form-footer">
        <button className="primary" disabled={busy}>
          {busy ? '处理中…' : label}
        </button>
        <span role="status">{message}</span>
      </div>
    </form>
  );
}
export function SelfForm({ state, refresh }: { state: Snapshot; refresh: () => Promise<void> }) {
  const [profile, setProfile] = useState(state.self);
  const [aliases, setAliases] = useState(profile.aliases.join('，'));
  return (
    <section className="panel form-panel">
      <div className="eyebrow">MY PROFILE</div>
      <h2>让分析更了解你</h2>
      <p className="muted">别名用于识别群聊中与你有关的话题；性格和风格用于调整建议。</p>
      <Form
        save={async () => {
          await send('/self', { ...profile, aliases: splitList(aliases) }, 'PUT');
          await refresh();
        }}
      >
        <Field label="你的称呼">
          <input
            required
            maxLength={80}
            value={profile.name}
            onChange={(event) => setProfile({ ...profile, name: event.target.value })}
          />
        </Field>
        <Field label="其他称呼 / 昵称" hint="支持多个，用逗号分隔。">
          <input
            value={aliases}
            onChange={(event) => setAliases(event.target.value)}
            placeholder="大毛，小毛，同学…"
          />
        </Field>
        <Field label="性格特点">
          <textarea
            value={profile.personality}
            maxLength={2000}
            onChange={(event) => setProfile({ ...profile, personality: event.target.value })}
            placeholder="例如：慢热，容易反复思考对方的意思"
          />
        </Field>
        <Field label="沟通风格与期待">
          <textarea
            value={profile.style}
            maxLength={2000}
            onChange={(event) => setProfile({ ...profile, style: event.target.value })}
            placeholder="例如：希望表达直接一些，但不要显得催促"
          />
        </Field>
      </Form>
    </section>
  );
}
export function ContactForm({ contact, done }: { contact?: Contact; done: () => Promise<void> }) {
  const [name, setName] = useState(contact?.name ?? '');
  const [qq, setQq] = useState(contact?.qq ?? '');
  const [tags, setTags] = useState(contact?.tags.join('，') ?? '');
  const [bio, setBio] = useState(contact?.bio ?? '');
  const [groups, setGroups] = useState(contact?.groupIds.join('，') ?? '');
  const [traits, setTraits] = useState(
    contact?.traits ?? { likes: '', boundaries: '', communication: '' },
  );
  const [friends, setFriends] = useState<{ user_id: string | number; nickname: string }[]>([]);
  const [bridgeError, setBridgeError] = useState('');
  async function loadFriends() {
    try {
      const result = await api<unknown>('/qq/friends');
      setFriends(
        z
          .array(z.object({ user_id: z.union([z.string(), z.number()]), nickname: z.string() }))
          .parse(result),
      );
      setBridgeError('');
    } catch {
      setBridgeError('无法读取好友列表，请检查 QQ 连接，也可以手动填写 QQ 号码。');
    }
  }
  return (
    <section className="panel form-panel">
      <div className="eyebrow">CONTACT DOSSIER</div>
      <h2>{contact ? '编辑对象档案' : '认识一位对话对象'}</h2>
      <Form
        label={contact ? '保存档案' : '建立档案并导入历史'}
        save={async () => {
          await send(
            contact ? `/contacts/${contact.id}` : '/contacts',
            {
              name,
              qq,
              tags: splitList(tags),
              bio,
              groupIds: splitList(groups),
              ...(contact ? { traits } : {}),
            },
            contact ? 'PUT' : 'POST',
          );
          await done();
        }}
      >
        <div className="two-col">
          <Field label="称呼">
            <input
              required
              value={name}
              maxLength={80}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field label="绑定 QQ 号码">
            <input
              required
              disabled={Boolean(contact)}
              pattern="\d{5,15}"
              value={qq}
              onChange={(event) => setQq(event.target.value)}
            />
          </Field>
        </div>
        {!contact && (
          <>
            <button type="button" className="subtle" onClick={() => void loadFriends()}>
              从已连接的 QQ 读取好友
            </button>
            {friends.length > 0 && (
              <Field label="选择好友">
                <select
                  value={qq}
                  onChange={(event) => {
                    setQq(event.target.value);
                    const friend = friends.find(
                      (item) => String(item.user_id) === event.target.value,
                    );
                    if (friend) setName(friend.nickname);
                  }}
                >
                  <option value="">请选择</option>
                  {friends.map((friend) => (
                    <option key={friend.user_id} value={friend.user_id}>
                      {friend.nickname} · {friend.user_id}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <p role="status">{bridgeError}</p>
          </>
        )}
        <Field label="标签">
          <input
            value={tags}
            onChange={(event) => setTags(event.target.value)}
            placeholder="朋友，同事，慢热"
          />
        </Field>
        <Field label="对象简介">
          <textarea
            maxLength={4000}
            value={bio}
            onChange={(event) => setBio(event.target.value)}
            placeholder="你们的关系、相处背景、希望 AI 了解的信息"
          />
        </Field>
        <Field
          label="共同群 QQ 号码"
          hint="用逗号分隔。仅监视明确指定的群；AI 会结合对象与上下文判断是否与你有关。"
        >
          <input
            value={groups}
            onChange={(event) => setGroups(event.target.value)}
            placeholder="可留空，仅监视私聊"
          />
        </Field>
        {contact && (
          <>
            <h3>长期沟通画像</h3>
            <p className="muted">
              AI 在会话归纳时更新；你可以修订，正在进行的请求不会覆盖本次修订。
            </p>
            <Field label="喜好">
              <textarea
                value={traits.likes}
                onChange={(event) => setTraits({ ...traits, likes: event.target.value })}
              />
            </Field>
            <Field label="忌讳与边界">
              <textarea
                value={traits.boundaries}
                onChange={(event) => setTraits({ ...traits, boundaries: event.target.value })}
              />
            </Field>
            <Field label="沟通习惯">
              <textarea
                value={traits.communication}
                onChange={(event) => setTraits({ ...traits, communication: event.target.value })}
              />
            </Field>
          </>
        )}
      </Form>
    </section>
  );
}
export function SettingsForm({
  state,
  refresh,
}: {
  state: Snapshot;
  refresh: () => Promise<void>;
}) {
  const [settings, setSettings] = useState(state.settings);
  const [apiKey, setApiKey] = useState('');
  const [qqToken, setQqToken] = useState('');
  return (
    <section className="panel form-panel">
      <div className="eyebrow">CONNECTION & INTELLIGENCE</div>
      <h2>连接与 AI 设置</h2>
      <p className="muted">密钥在后端加密保存。留空表示保留已有密钥。微信连接待后续实现。</p>
      <Form
        save={async () => {
          await send(
            '/settings',
            { ...settings, ...(apiKey ? { apiKey } : {}), ...(qqToken ? { qqToken } : {}) },
            'PUT',
          );
          setApiKey('');
          setQqToken('');
          await refresh();
        }}
      >
        <h3>AI API · OpenAI 兼容协议</h3>
        <Field label="API Base URL">
          <input
            required
            type="url"
            value={settings.baseUrl}
            onChange={(event) => setSettings({ ...settings, baseUrl: event.target.value })}
          />
        </Field>
        <Field label={`API Key ${state.hasApiKey ? '· 已配置' : '· 未配置'}`}>
          <input
            type="password"
            autoComplete="new-password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
          />
        </Field>
        <div className="two-col">
          <Field label="轻量判断模型">
            <input
              required
              value={settings.lightModel}
              onChange={(event) => setSettings({ ...settings, lightModel: event.target.value })}
            />
          </Field>
          <Field label="完整分析 / 归纳模型">
            <input
              required
              value={settings.fullModel}
              onChange={(event) => setSettings({ ...settings, fullModel: event.target.value })}
            />
          </Field>
        </div>
        <h3>QQ · SnowLuma OneBot v11</h3>
        <Field
          label="WebSocket 地址"
          hint="填写 QQ 所在电脑的局域网 IP 和 OneBot 正向 WebSocket 端口。"
        >
          <input
            value={settings.qqUrl}
            onChange={(event) => setSettings({ ...settings, qqUrl: event.target.value })}
            placeholder="ws://192.168.1.10:3001"
          />
        </Field>
        <Field label="自身 QQ 号码">
          <input
            pattern="\d{5,15}"
            value={settings.selfQq}
            onChange={(event) => setSettings({ ...settings, selfQq: event.target.value })}
          />
        </Field>
        <Field label={`OneBot Access Token ${state.hasQqToken ? '· 已配置' : '· 未配置'}`}>
          <input
            type="password"
            autoComplete="new-password"
            value={qqToken}
            onChange={(event) => setQqToken(event.target.value)}
          />
        </Field>
        <h3>分析节奏</h3>
        <p className="muted small">
          合并窗口用于延后轻量摘要与情绪分析；累计条数和静默时间用于触发“是否需要建议”的轻量判断。
        </p>
        <div className="two-col">
          <Field
            label="消息合并窗口（秒）"
            hint="默认 3 秒；新消息会重新开始计时，合并后统一分析。"
          >
            <input
              type="number"
              required
              min={0.1}
              max={60}
              step={0.1}
              value={settings.mergeWindowSeconds}
              onChange={(event) =>
                setSettings({ ...settings, mergeWindowSeconds: Number(event.target.value) })
              }
            />
          </Field>
          <Field label="轻量建议判断累计消息数（条）">
            <input
              type="number"
              min={2}
              max={200}
              value={settings.messageThreshold}
              onChange={(event) =>
                setSettings({ ...settings, messageThreshold: Number(event.target.value) })
              }
            />
          </Field>
          <Field
            label="轻量建议判断静默时间（秒）"
            hint="双方均未产生新消息时计时；达到该时长可直接触发检查。"
          >
            <input
              type="number"
              min={5}
              max={600}
              value={settings.idleSeconds}
              onChange={(event) =>
                setSettings({ ...settings, idleSeconds: Number(event.target.value) })
              }
            />
          </Field>
          <Field label="采用建议后的冷却（分钟）">
            <input
              type="number"
              min={1}
              max={1440}
              value={settings.cooldownMinutes}
              onChange={(event) =>
                setSettings({ ...settings, cooldownMinutes: Number(event.target.value) })
              }
            />
          </Field>
          <Field label="每次历史导入分页上限">
            <input
              type="number"
              min={1}
              max={200}
              value={settings.historyPages}
              onChange={(event) =>
                setSettings({ ...settings, historyPages: Number(event.target.value) })
              }
            />
          </Field>
        </div>
      </Form>
    </section>
  );
}
