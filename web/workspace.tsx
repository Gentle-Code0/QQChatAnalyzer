import { useState } from 'react';
import type { Contact, Conversation, ConversationDetail, Snapshot } from '../shared/schema';
import { formatTime } from './api';

export function Workspace({
  state,
  contact,
  conversation,
  detail,
  selectConversation,
  edit,
  action,
}: {
  state: Snapshot;
  contact: Contact;
  conversation?: Conversation;
  detail?: ConversationDetail;
  selectConversation: (id: string) => void;
  edit: () => void;
  action: (path: string, value?: unknown) => Promise<void>;
}) {
  const [tab, setTab] = useState('对话');
  const conversations = state.conversations.filter(
    (item) =>
      item.contactId === contact.id &&
      (item.kind === 'private' || contact.groupIds.includes(item.peerId)),
  );
  const signal = detail?.observations.at(-1);
  const latestDecision = detail?.decisions.at(-1);
  return (
    <>
      <section className="contact-heading">
        <div className="avatar large">{contact.name.slice(0, 1)}</div>
        <div className="grow">
          <div className="eyebrow">LIVE CONVERSATION</div>
          <h1>
            {contact.name}
            <span className="pill">QQ · {contact.qq}</span>
          </h1>
          <p className="muted">{contact.bio || '从每一次对话，慢慢了解彼此。'}</p>
          <div className="tags">
            {contact.gender !== '未填写' && <span>性别：{contact.gender}</span>}
            {contact.tags.map((tag) => (
              <span key={tag}>{tag}</span>
            ))}
          </div>
        </div>
        <button onClick={edit}>编辑档案</button>
        <button
          className={contact.paused ? 'primary' : ''}
          onClick={() => void action(`/contacts/${contact.id}/pause`, { paused: !contact.paused })}
        >
          {contact.paused ? '恢复对象 AI' : '暂停对象 AI'}
        </button>
      </section>
      <div className="session-bar">
        <select
          aria-label="选择会话"
          value={conversation?.id ?? ''}
          onChange={(event) => selectConversation(event.target.value)}
        >
          {conversations.map((item) => (
            <option key={item.id} value={item.id}>
              {item.kind === 'private' ? '私聊' : `群聊 · ${item.peerId}`}
              {item.paused ? '（AI 已暂停）' : ''}
            </option>
          ))}
        </select>
        <span className="status-text">
          {contact.paused ? '对象 AI 已暂停' : conversation?.status}
        </span>
        <span className="grow" />
        {conversation && (
          <>
            <button
              onClick={() =>
                void action(`/conversations/${conversation.id}/pause`, {
                  paused: !conversation.paused,
                })
              }
            >
              {conversation.paused ? '恢复会话 AI' : '暂停会话 AI'}
            </button>
            <button
              disabled={contact.paused || conversation.paused}
              onClick={() => void action(`/conversations/${conversation.id}/check`)}
            >
              重新检查
            </button>
          </>
        )}
      </div>
      {conversation?.error && (
        <div className="notice error" role="alert">
          {conversation.error}
        </div>
      )}
      <div className="workspace-grid">
        <div className="main-column">
          <section className="panel summary">
            <div className="section-heading">
              <h3>当前对话摘要</h3>
              <span className="pill soft">持续增量更新</span>
            </div>
            <p className="prewrap">
              {conversation?.summary ||
                '等待聊天记录与 AI 分析。新消息到来时，会以最近一次有效摘要继续更新。'}
            </p>
          </section>
          {latestDecision && (
            <section className="panel advice-panel" aria-live="polite">
              <div className="section-heading">
                <h3>{latestDecision.needed ? '此刻的提醒' : '当前判断 · 暂无需建议'}</h3>
                <span className="pill soft">{latestDecision.trigger}</span>
              </div>
              <p className="prewrap">
                {latestDecision.needed ? latestDecision.advice : latestDecision.reason}
              </p>
              {latestDecision.needed && (
                <details>
                  <summary>
                    查看判断依据
                    {latestDecision.memoryIds.length
                      ? ` · 关联 ${latestDecision.memoryIds.length} 条历史记忆`
                      : ''}
                  </summary>
                  <p className="prewrap">{latestDecision.reason}</p>
                </details>
              )}
              <div className="section-heading">
                <small className="muted">{formatTime(latestDecision.time)}</small>
                {latestDecision.needed && conversation && (
                  <button
                    disabled={latestDecision.adopted}
                    onClick={() =>
                      void action(`/conversations/${conversation.id}/adopt/${latestDecision.id}`)
                    }
                  >
                    {latestDecision.adopted ? '已采用 · 冷却中' : '已采用这条建议'}
                  </button>
                )}
              </div>
            </section>
          )}
          <section className="panel conversation-panel">
            <div className="tabs">
              {['对话', '历史记忆', '判断记录'].map((item) => (
                <button
                  key={item}
                  className={tab === item ? 'active' : ''}
                  onClick={() => setTab(item)}
                >
                  {item}
                </button>
              ))}
            </div>
            {tab === '对话' && (
              <div className="messages">
                {detail?.messages.length ? (
                  detail.messages.map((message) => (
                    <article
                      key={message.id}
                      className={`message ${message.senderId === state.settings.selfQq ? 'self' : ''}`}
                    >
                      <div className="message-meta">
                        <strong>{message.senderName}</strong>
                        <time>{formatTime(message.time)}</time>
                        <span>{message.source === 'history' ? '历史' : '实时'}</span>
                      </div>
                      <div className="bubble">{message.text}</div>
                    </article>
                  ))
                ) : (
                  <Empty text="还没有消息" sub="连接 QQ 后，指定对象的聊天会出现在这里。" />
                )}
                <p className="footnote">只读观察 · 显示最近 200 条 · 不发送消息</p>
              </div>
            )}
            {tab === '历史记忆' && (
              <div className="record-list">
                <div className="notice">
                  {contact.historyStatus}
                  <button onClick={() => void action(`/contacts/${contact.id}/history`)}>
                    继续读取 / 重试
                  </button>
                </div>
                {detail?.memories.length ? (
                  [...detail.memories]
                    .sort((left, right) => right.time - left.time)
                    .map((memory) => (
                      <article key={memory.id} className="memory">
                        <div className="message-meta">
                          <span className="pill">
                            {
                              {
                                event: '重要事件',
                                promise: '约定',
                                relationship: '关系节点',
                                emotion: '情绪节点',
                              }[memory.kind]
                            }
                          </span>
                          <time>{formatTime(memory.time)}</time>
                        </div>
                        <p>{memory.text}</p>
                        <div className="tags">
                          {memory.keywords.map((keyword) => (
                            <span key={keyword}>{keyword}</span>
                          ))}
                        </div>
                        <small className="muted">
                          参考权重{' '}
                          {(
                            1 /
                            (1 + Math.max(0, Date.now() - memory.time) / 86400000 / 90)
                          ).toFixed(2)}{' '}
                          · 来源 {memory.sourceIds.join('、')}
                        </small>
                      </article>
                    ))
                ) : (
                  <Empty
                    text="记忆会慢慢积累"
                    sub="重要事件、约定和关系变化会带着时间与来源保存在这里。"
                  />
                )}
              </div>
            )}
            {tab === '判断记录' && (
              <div className="record-list">
                {detail?.decisions.length ? (
                  [...detail.decisions].reverse().map((decision) => (
                    <article className="memory" key={decision.id}>
                      <div className="message-meta">
                        <span className="pill">{decision.needed ? '需要提醒' : '无需建议'}</span>
                        <time>{formatTime(decision.time)}</time>
                        <span>{decision.trigger}</span>
                      </div>
                      <p className="prewrap">{decision.reason}</p>
                      {decision.advice && <blockquote>{decision.advice}</blockquote>}
                      {decision.needed && conversation && (
                        <button
                          disabled={decision.adopted}
                          onClick={() =>
                            void action(`/conversations/${conversation.id}/adopt/${decision.id}`)
                          }
                        >
                          {decision.adopted ? '已采用 · 暂停重复提醒' : '已采用这条建议'}
                        </button>
                      )}
                    </article>
                  ))
                ) : (
                  <Empty
                    text="安静观察，适时提醒"
                    sub="达到分析条件后，无论是否需要建议，都会记录判断理由。"
                  />
                )}
              </div>
            )}
          </section>
        </div>
        <aside className="insights-column">
          <section className="panel">
            <div className="section-heading">
              <h3>关系气象</h3>
              <span className="live-dot" />
            </div>
            <p className="muted small">AI 基于文字的推测，数值不代表真实心理。</p>
            <Metric label="对你的态度" value={signal?.attitude} />
            <Metric label="情绪效价" value={signal?.emotion} />
            <div className="mood">{signal?.mood || '等待观察'}</div>
            <p className="small prewrap">
              {signal?.reason || '足够的对话信息，能让判断更有依据。'}
            </p>
            {detail && detail.observations.length > 1 && (
              <svg
                className="sparkline"
                viewBox="0 0 280 90"
                role="img"
                aria-label="近期态度和情绪趋势"
              >
                <path d="M0 45H280" stroke="#dce7f2" strokeDasharray="4 4" />
                {['attitude', 'emotion'].map((field, index) => (
                  <polyline
                    key={field}
                    fill="none"
                    stroke={index === 0 ? '#689fda' : '#d99dc2'}
                    strokeWidth="2.5"
                    points={detail.observations
                      .slice(-30)
                      .map(
                        (observation, pointIndex, all) =>
                          `${(pointIndex * 280) / Math.max(1, all.length - 1)},${45 - (field === 'attitude' ? observation.attitude : observation.emotion) * 0.4}`,
                      )
                      .join(' ')}
                  />
                ))}
              </svg>
            )}
            <small className="muted">蓝线：态度 · 粉线：情绪</small>
          </section>
          <section className="panel">
            <h3>长期沟通画像</h3>
            <Trait label="喜欢的事" value={contact.traits.likes} />
            <Trait label="忌讳与边界" value={contact.traits.boundaries} />
            <Trait label="沟通习惯" value={contact.traits.communication} />
            <button className="subtle full" onClick={edit}>
              修订画像
            </button>
          </section>
          <section className="quiet-card">
            <div className="eyebrow">A LITTLE SPACE</div>
            <h3>给对话一点呼吸</h3>
            <p>平时持续观察，只在有必要时提醒。理解一段关系，需要上下文，也需要耐心。</p>
            {conversation && conversation.adoptedUntil > Date.now() && (
              <span className="pill">建议冷却至 {formatTime(conversation.adoptedUntil)}</span>
            )}
          </section>
        </aside>
      </div>
    </>
  );
}
function Metric({ label, value }: { label: string; value?: number }) {
  return (
    <div className="metric">
      <div>
        <span>{label}</span>
        <strong>{value === undefined ? '—' : `${value > 0 ? '+' : ''}${value}`}</strong>
      </div>
      <div className="meter">
        <span style={{ width: `${((value ?? 0) + 100) / 2}%` }} />
      </div>
    </div>
  );
}
function Trait({ label, value }: { label: string; value: string }) {
  return (
    <div className="trait">
      <small>{label}</small>
      <p>{value || '尚待了解'}</p>
    </div>
  );
}
export function Empty({ text, sub }: { text: string; sub: string }) {
  return (
    <div className="empty">
      <div className="empty-mark">◌</div>
      <h3>{text}</h3>
      <p>{sub}</p>
    </div>
  );
}
