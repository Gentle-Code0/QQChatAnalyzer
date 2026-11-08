import { StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Snapshot, ConversationDetail } from '../shared/schema';
import { api, send, ApiError } from './api';
import { ContactForm, SelfForm, SettingsForm, Form, Field } from './forms';
import { Workspace, Empty } from './workspace';
import './style.css';

function App() {
  const [state, setState] = useState<Snapshot>();
  const [loggedIn, setLoggedIn] = useState<boolean>();
  const [password, setPassword] = useState('');
  const [page, setPage] = useState('对象档案');
  const [selected, setSelected] = useState('');
  const [conversationId, setConversationId] = useState('');
  const [detail, setDetail] = useState<ConversationDetail>();
  const [error, setError] = useState('');
  const contact = state?.contacts.find((item) => item.id === selected);
  const conversation =
    state?.conversations.find((item) => item.id === conversationId) ??
    state?.conversations.find((item) => item.contactId === selected && item.kind === 'private');
  const activeId = conversation?.id;
  const refresh = useCallback(async () => {
    try {
      const result = await api<Snapshot>('/state');
      setState(result);
      setLoggedIn(true);
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) {
        setLoggedIn(false);
        setState(undefined);
        setDetail(undefined);
      } else throw failure;
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const result = await api<Snapshot>('/state', { signal: controller.signal });
        if (!controller.signal.aborted) {
          setState(result);
          setLoggedIn(true);
        }
      } catch (failure) {
        if (controller.signal.aborted) return;
        if (failure instanceof ApiError && failure.status === 401) {
          setLoggedIn(false);
          setState(undefined);
          setDetail(undefined);
        } else setError('无法连接后端，请检查服务。');
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 2000);
    }
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, []);
  useEffect(() => {
    setDetail(undefined);
    if (!activeId || !loggedIn) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const result = await api<ConversationDetail>(`/conversations/${activeId}`, {
          signal: controller.signal,
        });
        if (!controller.signal.aborted) setDetail(result);
      } catch {
        if (!controller.signal.aborted) setError('会话刷新失败，请检查连接。');
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 2000);
    }
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [activeId, loggedIn]);
  async function action(path: string, value?: unknown) {
    try {
      await send(path, value);
      await refresh();
      if (activeId) setDetail(await api<ConversationDetail>(`/conversations/${activeId}`));
      setError('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '操作失败');
    }
  }
  function pick(id: string) {
    setSelected(id);
    setConversationId('');
    setPage('观察室');
  }
  if (!loggedIn || !state)
    return (
      <div className="login-page">
        <div className="login-card">
          <div className="brand">
            <span className="brand-icon">◈</span>ChatAnalyzer
          </div>
          <div className="eyebrow">YOUR CONVERSATION OBSERVATORY</div>
          <h1>
            听见对话里的
            <br />
            细微变化。
          </h1>
          <p className="muted">你的对话观察室 · 只读连接，适时提醒</p>
          <Form
            label="进入观察室"
            save={async () => {
              await send('/login', { password });
              setPassword('');
              await refresh();
            }}
          >
            <Field label="访问密码">
              <input
                autoFocus
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </Field>
          </Form>
          {error && <p role="alert">{error}</p>}
          <small className="muted">
            {loggedIn === undefined ? '正在连接本地服务…' : '请使用部署时设置的访问密码'}
          </small>
        </div>
        <div className="login-orbit" />
      </div>
    );
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(event) => {
            event.preventDefault();
            setPage('对象档案');
          }}
        >
          <span className="brand-icon">◈</span>
          <span>
            ChatAnalyzer<small>对话观察室</small>
          </span>
        </a>
        <div className={`connection ${state.bridge.connected ? 'online' : ''}`}>
          <span className="live-dot" />
          <div>
            {state.bridge.connected ? 'QQ 已连接' : 'QQ 未连接'}
            <small>{state.bridge.status}</small>
          </div>
        </div>
        <nav>
          {['对象档案', '我的档案', '连接设置'].map((item, index) => (
            <button
              key={item}
              className={
                page === item || (index === 0 && ['观察室', '编辑档案', '新建档案'].includes(page))
                  ? 'active'
                  : ''
              }
              onClick={() => setPage(item)}
            >
              <span>{['◇', '♧', '⚙'][index]}</span>
              {item}
            </button>
          ))}
        </nav>
        <div className="sidebar-caption">
          正在关注 <span>{state.contacts.length}</span>
        </div>
        <div className="contact-nav">
          {state.contacts.map((item) => (
            <button
              className={selected === item.id && page === '观察室' ? 'selected' : ''}
              key={item.id}
              onClick={() => pick(item.id)}
            >
              <span className="avatar">{item.name.slice(0, 1)}</span>
              <span>
                {item.name}
                <small>{item.paused ? 'AI 已暂停' : 'QQ 私聊与指定群'}</small>
              </span>
              <span className={`tiny-dot ${item.paused ? 'paused' : ''}`} />
            </button>
          ))}
        </div>
        <div className="sidebar-bottom">
          <span className="pill">微信 · TODO</span>
          <p>为理解留一点空间。</p>
          <button className="subtle" onClick={() => void action('/logout')}>
            退出登录
          </button>
        </div>
      </aside>
      <main className="content">
        <header className="topbar">
          <span>
            WORKSPACE <span className="breadcrumb">/ {page}</span>
          </span>
          <span>{state.self.name}的观察室</span>
        </header>
        {error && (
          <div role="alert" className="notice error">
            {error}
            <button onClick={() => setError('')}>关闭</button>
          </div>
        )}
        {page === '对象档案' && (
          <>
            <div className="page-heading">
              <div>
                <div className="eyebrow">PEOPLE & STORIES</div>
                <h1>每段关系，都值得被理解。</h1>
                <p className="muted">从一份档案开始，让重要的对话有迹可循。</p>
              </div>
              <button className="primary" onClick={() => setPage('新建档案')}>
                ＋ 建立对象档案
              </button>
            </div>
            <section className="overview">
              <div>
                <span>关注的对象</span>
                <strong>{state.contacts.length.toString().padStart(2, '0')}</strong>
              </div>
              <div>
                <span>监视中的会话</span>
                <strong>
                  {state.conversations
                    .filter(
                      (item) =>
                        !item.paused &&
                        !state.contacts.find((person) => person.id === item.contactId)?.paused,
                    )
                    .length.toString()
                    .padStart(2, '0')}
                </strong>
              </div>
              <div>
                <span>观察方式</span>
                <strong className="text-stat">只读 · 轻量优先</strong>
              </div>
            </section>
            <div className="section-heading">
              <h2>对象档案</h2>
              <span className="muted small">记录相处，也保留分寸</span>
            </div>
            <div className="contact-grid">
              {state.contacts.map((item) => (
                <button className="contact-card" key={item.id} onClick={() => pick(item.id)}>
                  <div className="section-heading">
                    <span className="avatar large">{item.name.slice(0, 1)}</span>
                    <span className="pill">{item.paused ? '已暂停' : '持续观察'}</span>
                  </div>
                  <h2>{item.name}</h2>
                  <small className="muted">QQ · {item.qq}</small>
                  <p>{item.bio || '等待写下你们的故事。'}</p>
                  <div className="tags">
                    {item.gender !== '未填写' && <span>性别：{item.gender}</span>}
                    {item.tags.map((tag) => (
                      <span key={tag}>{tag}</span>
                    ))}
                  </div>
                  <div className="card-bottom">
                    <span>进入观察室</span>
                    <span>↗</span>
                  </div>
                </button>
              ))}
              <button className="add-card" onClick={() => setPage('新建档案')}>
                <span>＋</span>
                <h3>添加一位对象</h3>
                <p>绑定 QQ，自动导入可读取的历史</p>
              </button>
            </div>
            {!state.hasApiKey && (
              <div className="notice">
                还未配置 AI API。<button onClick={() => setPage('连接设置')}>前往设置</button>
              </div>
            )}
          </>
        )}
        {page === '我的档案' && <SelfForm state={state} refresh={refresh} />}
        {page === '连接设置' && <SettingsForm state={state} refresh={refresh} />}
        {page === '新建档案' && (
          <ContactForm
            done={async () => {
              await refresh();
              setPage('对象档案');
            }}
          />
        )}
        {page === '编辑档案' && contact && (
          <ContactForm
            key={contact.id}
            contact={contact}
            done={async () => {
              await refresh();
              setPage('观察室');
            }}
          />
        )}
        {page === '观察室' &&
          (contact ? (
            <Workspace
              key={contact.id}
              state={state}
              contact={contact}
              conversation={conversation}
              detail={detail}
              selectConversation={setConversationId}
              edit={() => setPage('编辑档案')}
              action={action}
            />
          ) : (
            <Empty text="选择一个对象" sub="从左侧打开对象档案。" />
          ))}
      </main>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
