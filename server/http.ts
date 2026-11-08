import express, { type ErrorRequestHandler } from 'express';
import { z } from 'zod';
import { Auth, sameOrigin } from './auth.js';
import { Application } from './application.js';
import { validateEndpoint } from './bridge.js';
import {
  contactInputSchema,
  contactSchema,
  selfProfileSchema,
  settingsSchema,
  traitsSchema,
} from '../shared/schema.js';

export function createApi(application: Application, password: string) {
  const app = express();
  const auth = new Auth(password);
  const store = application.store;
  app.disable('x-powered-by');
  app.use((_request, response, next) => {
    response.set({
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    next();
  });
  app.use(express.json({ limit: '128kb' }), sameOrigin);
  app.get('/api/health', (_request, response) => response.json({ ok: true }));
  app.post('/api/login', (request, response) => auth.login(request, response));
  app.use('/api', auth.require);
  app.post('/api/logout', (request, response) => auth.logout(request, response));
  app.get('/api/state', (_request, response) => response.json(application.snapshot()));
  app.put('/api/self', (request, response) => {
    store.self = selfProfileSchema.parse(request.body);
    response.json({ ok: true });
  });
  app.put('/api/settings', (request, response) => {
    const input = settingsSchema.parse(request.body);
    const secrets = z
      .object({ apiKey: z.string().max(4000).optional(), qqToken: z.string().max(4000).optional() })
      .parse(request.body);
    validateEndpoint(input.baseUrl, ['https:', 'http:']);
    if (input.qqUrl) validateEndpoint(input.qqUrl, ['ws:', 'wss:']);
    if (input.qqUrl && !input.selfQq) {
      response.status(400).json({ error: '配置 QQ 地址时必须填写自身 QQ 号码' });
      return;
    }
    if (
      store.contacts().length &&
      store.settings.selfQq &&
      input.selfQq !== store.settings.selfQq
    ) {
      response
        .status(409)
        .json({ error: '已有对象档案时不能更换自身 QQ 账号，请使用独立数据目录' });
      return;
    }
    const reconnect =
      input.qqUrl !== store.settings.qqUrl ||
      input.selfQq !== store.settings.selfQq ||
      secrets.qqToken !== undefined;
    store.settings = settingsSchema.parse(input);
    if (secrets.apiKey !== undefined) store.setSecret('apiKey', secrets.apiKey);
    if (secrets.qqToken !== undefined) store.setSecret('qqToken', secrets.qqToken);
    if (reconnect) application.reconnect();
    for (const conversation of store.conversations())
      application.engine.notify(conversation.id, false);
    response.json({ ok: true });
  });
  app.post('/api/settings/ai/test', async (request, response) => {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    response.once('close', cancel);
    try {
      const result = await application.testAi(request.body, controller.signal);
      if (!controller.signal.aborted) response.json(result);
    } finally {
      response.off('close', cancel);
    }
  });
  app.get('/api/qq/friends', async (_request, response) => {
    response.json(await application.bridge?.request('get_friend_list', {}));
  });
  app.get('/api/qq/groups', async (_request, response) => {
    response.json(await application.bridge?.request('get_group_list', {}));
  });
  app.post('/api/qq/reconnect', (_request, response) => {
    application.reconnect();
    response.json({ ok: true });
  });
  app.post('/api/contacts', (request, response) => {
    const input = contactInputSchema.parse(request.body);
    if (store.contacts().some((contact) => contact.qq === input.qq)) {
      response.status(409).json({ error: '该 QQ 已建立对象档案' });
      return;
    }
    const contact = contactSchema.parse({
      ...input,
      id: application.createId(),
      createdAt: Date.now(),
    });
    store.saveContact(contact);
    application.ensureConversations(contact);
    void application.importHistory(contact.id);
    response.status(201).json(contact);
  });
  app.put('/api/contacts/:id', (request, response) => {
    const contact = store.contact(String(request.params.id));
    if (!contact) {
      response.sendStatus(404);
      return;
    }
    const input = contactInputSchema.extend({ traits: traitsSchema }).parse(request.body);
    if (input.qq !== contact.qq) {
      response.status(409).json({ error: '对象 QQ 绑定不可更换，请为新账号另建档案' });
      return;
    }
    store.saveContact({ ...contact, ...input, traitsRevision: contact.traitsRevision + 1 });
    application.ensureConversations({ ...contact, ...input });
    for (const conversation of store
      .conversations()
      .filter(
        (item) =>
          item.contactId === contact.id &&
          item.kind === 'group' &&
          !input.groupIds.includes(item.peerId),
      )) {
      application.engine.cancel(conversation.id, '共同群监视已移除');
      store.saveConversation({ ...conversation, paused: true, status: '群监视已移除' });
    }
    response.json({ ok: true });
  });
  app.post('/api/contacts/:id/history', (request, response) => {
    if (!store.contact(String(request.params.id))) {
      response.sendStatus(404);
      return;
    }
    void application.importHistory(String(request.params.id));
    response.status(202).json({ ok: true });
  });
  app.post('/api/contacts/:id/pause', (request, response) => {
    const contact = store.contact(String(request.params.id));
    if (!contact) {
      response.sendStatus(404);
      return;
    }
    const { paused } = z.object({ paused: z.boolean() }).parse(request.body);
    store.saveContact({ ...contact, paused });
    for (const conversation of store
      .conversations()
      .filter((item) => item.contactId === contact.id)) {
      if (paused) application.engine.cancel(conversation.id, '对象 AI 已暂停');
      else application.engine.notify(conversation.id);
      store.saveConversation({
        ...store.conversation(conversation.id)!,
        status: paused ? '对象 AI 已暂停' : '等待分析',
        error: '',
      });
    }
    response.json({ ok: true });
  });
  app.get('/api/conversations/:id', (request, response) => {
    const conversation = store.conversation(String(request.params.id));
    if (!conversation) {
      response.sendStatus(404);
      return;
    }
    response.json({
      activity: application.engine.activity(conversation.id),
      messages: store.recentMessages(conversation.id),
      memories: store.memories(conversation.contactId),
      observations: store.observations(conversation.id),
      decisions: store.decisions(conversation.id),
    });
  });
  app.post('/api/conversations/:id/pause', (request, response) => {
    const conversation = store.conversation(String(request.params.id));
    if (!conversation) {
      response.sendStatus(404);
      return;
    }
    const { paused } = z.object({ paused: z.boolean() }).parse(request.body);
    store.saveConversation({
      ...conversation,
      paused,
      status: paused ? '会话 AI 已暂停' : '等待分析',
      error: '',
    });
    if (paused) application.engine.cancel(conversation.id, '会话 AI 已暂停');
    else application.engine.notify(conversation.id);
    response.json({ ok: true });
  });
  app.post('/api/conversations/:id/check', (request, response) => {
    if (!store.conversation(String(request.params.id))) {
      response.sendStatus(404);
      return;
    }
    application.engine.flush(String(request.params.id));
    response.status(202).json({ ok: true });
  });
  app.post('/api/conversations/:id/adopt/:decisionId', (request, response) => {
    const conversation = store.conversation(String(request.params.id));
    if (!conversation) {
      response.sendStatus(404);
      return;
    }
    const decision = store
      .decisions(conversation.id)
      .find((item) => item.id === request.params.decisionId);
    if (!decision || !decision.needed) {
      response.sendStatus(404);
      return;
    }
    // Cancelling a running advice job prevents an older response from bypassing the newly set cooldown.
    application.engine.cancel(conversation.id, '已采用建议，重新安排冷却期间分析');
    store.saveDecision({ ...decision, adopted: true });
    store.saveConversation({
      ...conversation,
      adoptedUntil: Date.now() + store.settings.cooldownMinutes * 60000,
    });
    application.engine.notify(conversation.id);
    response.json({ ok: true });
  });
  const handleError: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
    if (error instanceof z.ZodError) {
      response.status(400).json({ error: '输入不符合要求，请检查字段内容' });
      return;
    }
    if (error instanceof Error && error.message.startsWith('地址协议无效')) {
      response.status(400).json({ error: error.message });
      return;
    }
    console.error('API 请求失败:', error instanceof Error ? error.name : 'unknown');
    response.status(500).json({ error: '操作失败，请检查连接与输入设置' });
  };
  app.use(handleError);
  return app;
}
