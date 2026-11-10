import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { z } from 'zod';
import { aiTestResultSchema, genderSchema, type Contact, type Snapshot } from '../shared/schema';
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
  const [gender, setGender] = useState(contact?.gender ?? '未填写');
  const [groups, setGroups] = useState(contact?.groupIds.join('，') ?? '');
  const [traits, setTraits] = useState(
    contact?.traits ?? { likes: '', boundaries: '', communication: '' },
  );
  const [friends, setFriends] = useState<{ user_id: string | number; nickname: string }[]>([]);
  const [bridgeError, setBridgeError] = useState('');
  const [friendSearch, setFriendSearch] = useState('');
  const friendQuery = friendSearch.trim().toLocaleLowerCase();
  const filteredFriends = friends.filter(
    (friend) =>
      String(friend.user_id).includes(friendQuery) ||
      friend.nickname.toLocaleLowerCase().includes(friendQuery),
  );
  const selectedFriend = friends.find((friend) => String(friend.user_id) === qq);
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
              gender,
              groupIds: splitList(groups),
              traits,
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
              <>
                <Field label="搜索好友">
                  <input
                    type="search"
                    value={friendSearch}
                    onChange={(event) => setFriendSearch(event.target.value)}
                    placeholder="输入 QQ 号或 QQ 昵称"
                  />
                </Field>
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
                    {selectedFriend && !filteredFriends.includes(selectedFriend) && (
                      <option value={selectedFriend.user_id}>
                        {selectedFriend.nickname} · {selectedFriend.user_id}（已选择）
                      </option>
                    )}
                    {filteredFriends.map((friend) => (
                      <option key={friend.user_id} value={friend.user_id}>
                        {friend.nickname} · {friend.user_id}
                      </option>
                    ))}
                  </select>
                </Field>
                <p className="muted" role="status">
                  {filteredFriends.length > 0
                    ? `找到 ${filteredFriends.length} 位好友`
                    : '没有匹配的好友，请尝试其他 QQ 号或昵称。'}
                </p>
              </>
            )}
            <p role="status">{bridgeError}</p>
          </>
        )}
        <Field label="性别">
          <select
            value={gender}
            onChange={(event) => setGender(genderSchema.parse(event.target.value))}
          >
            {genderSchema.options.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </Field>
        <Field label="标签">
          <input
            value={tags}
            onChange={(event) => setTags(event.target.value)}
            placeholder="朋友，同事，慢热"
          />
        </Field>
        <Field label="关系简介">
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
        <h3>长期沟通画像</h3>
        <p className="muted">AI 在会话归纳时更新；你可以修订，正在进行的请求不会覆盖本次修订。</p>
        <Field label="喜好">
          <textarea
            maxLength={4000}
            value={traits.likes}
            onChange={(event) => setTraits({ ...traits, likes: event.target.value })}
          />
        </Field>
        <Field label="忌讳与边界">
          <textarea
            maxLength={4000}
            value={traits.boundaries}
            onChange={(event) => setTraits({ ...traits, boundaries: event.target.value })}
          />
        </Field>
        <Field label="沟通习惯">
          <textarea
            maxLength={4000}
            value={traits.communication}
            onChange={(event) => setTraits({ ...traits, communication: event.target.value })}
          />
        </Field>
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
  const [testingAi, setTestingAi] = useState(false);
  const [aiTestMessage, setAiTestMessage] = useState('');
  const aiTestController = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    setAiTestMessage('');
    setTestingAi(false);
    return () => {
      aiTestController.current?.abort();
      aiTestController.current = undefined;
    };
  }, [settings.baseUrl, settings.model, apiKey]);
  async function testAi() {
    if (aiTestController.current) return;
    const controller = new AbortController();
    aiTestController.current = controller;
    setTestingAi(true);
    setAiTestMessage('正在测试 AI 调用及回传…');
    try {
      const result = aiTestResultSchema.parse(
        await api<unknown>('/settings/ai/test', {
          method: 'POST',
          signal: controller.signal,
          body: JSON.stringify({ baseUrl: settings.baseUrl, model: settings.model, apiKey }),
        }),
      );
      if (!controller.signal.aborted)
        setAiTestMessage(
          result.ok ? result.message : `连接失败（步骤：${result.step}）：${result.message}`,
        );
    } catch (error) {
      if (!controller.signal.aborted)
        setAiTestMessage(
          `连接失败（步骤：请求应用后端或读取测试结果）：${error instanceof Error ? error.message : '请求失败'}`,
        );
    } finally {
      if (aiTestController.current === controller) {
        aiTestController.current = undefined;
        setTestingAi(false);
      }
    }
  }

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
        <Field
          label="模型名称"
          hint="整个应用使用同一个模型；请选择支持图片输入及 JSON 输出的多模态模型。"
        >
          <input
            required
            value={settings.model}
            onChange={(event) => setSettings({ ...settings, model: event.target.value })}
          />
        </Field>
        <div className="form-footer">
          <button
            type="button"
            className="subtle"
            disabled={testingAi}
            onClick={() => void testAi()}
          >
            {testingAi ? '测试中…' : '测试 AI API'}
          </button>
          <span role="status">{aiTestMessage}</span>
        </div>
        <p className="muted small">
          测试当前填写的配置；Key 留空时使用已保存的 Key。测试会产生一次模型调用，不会保存配置。
        </p>
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
          摘要、建议判断和画像与记忆归纳独立累计消息；达到条数阈值直接检查，少量消息等待静默。摘要仅供后台
          AI 使用。
        </p>
        <div className="two-col">
          <Field
            label="消息合并窗口（秒）"
            hint="默认 60 秒；新消息重新计时，达到条数阈值可提前检查。"
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
          <Field label="建议必要性判断累计消息数（条）">
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
            label="建议必要性判断静默时间（秒）"
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
          <Field label="摘要分析累计消息数（条）">
            <input
              type="number"
              required
              min={2}
              max={200}
              value={settings.summaryMessageThreshold}
              onChange={(event) =>
                setSettings({ ...settings, summaryMessageThreshold: Number(event.target.value) })
              }
            />
          </Field>
          <Field label="摘要分析静默时间（秒）">
            <input
              type="number"
              required
              min={5}
              max={3600}
              value={settings.summaryIdleSeconds}
              onChange={(event) =>
                setSettings({ ...settings, summaryIdleSeconds: Number(event.target.value) })
              }
            />
          </Field>
          <Field label="画像与记忆归纳累计消息数（条）">
            <input
              type="number"
              required
              min={2}
              max={1000}
              value={settings.consolidationMessageThreshold}
              onChange={(event) =>
                setSettings({
                  ...settings,
                  consolidationMessageThreshold: Number(event.target.value),
                })
              }
            />
          </Field>
          <Field label="画像与记忆归纳静默时间（秒）">
            <input
              type="number"
              required
              min={5}
              max={86400}
              value={settings.consolidationIdleSeconds}
              onChange={(event) =>
                setSettings({ ...settings, consolidationIdleSeconds: Number(event.target.value) })
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
