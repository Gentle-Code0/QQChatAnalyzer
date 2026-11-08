import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { z } from 'zod';
import { Application } from '../server/application.js';
import { createApi } from '../server/http.js';
import { fixture } from './helpers.js';
import { analysisRunSchema, contactSchema } from '../shared/schema.js';

test(
  'API 要求认证、拒绝跨来源写入，状态不暴露密钥；档案绑定不可换号，性别与初始画像可保存',
  { timeout: 10000 },
  async () => {
    const data = fixture();
    data.store.setSecret('apiKey', 'invalid-api-test-key');
    const application = new Application(data.store);
    const server = createApi(application, 'invalid-test-password').listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    try {
      assert.equal((await fetch(`${base}/api/state`)).status, 401);
      assert.equal(
        (
          await fetch(`${base}/api/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Origin: 'http://evil.invalid' },
            body: JSON.stringify({ password: 'invalid-test-password' }),
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await fetch(`${base}/api/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: 'wrong' }),
          })
        ).status,
        401,
      );
      const login = await fetch(`${base}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'invalid-test-password' }),
      });
      const cookie = login.headers.get('set-cookie')?.split(';')[0];
      assert.ok(cookie);
      assert.match(login.headers.get('set-cookie') ?? '', /HttpOnly/);
      const state = await fetch(`${base}/api/state`, { headers: { Cookie: cookie } });
      const body = await state.text();
      assert.equal(state.status, 200);
      assert.equal(body.includes('invalid-api-test-key'), false);
      assert.match(body, /"hasApiKey":true/);
      application.engine.notify(data.conversation.id);
      const detail = await fetch(`${base}/api/conversations/${data.conversation.id}`, {
        headers: { Cookie: cookie },
      });
      const activity = z
        .object({ activity: z.array(analysisRunSchema) })
        .parse(await detail.json()).activity;
      assert.equal(activity.at(-1)?.status, 'waiting');
      assert.equal(activity.at(-1)?.steps[0]?.label, '等待消息合并');
      assert.equal((await fetch(`${base}/api/conversations/${data.conversation.id}`)).status, 401);

      const settings = {
        ...data.store.settings,
        mergeWindowSeconds: 4.5,
        messageThreshold: 12,
        idleSeconds: 25,
        cooldownMinutes: 1,
      };
      const saved = await fetch(`${base}/api/settings`, {
        method: 'PUT',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      });
      assert.equal(saved.status, 200);
      assert.deepEqual(data.store.settings, settings);
      const stateAfterSave = await fetch(`${base}/api/state`, { headers: { Cookie: cookie } });
      assert.match(await stateAfterSave.text(), /"mergeWindowSeconds":4.5/);
      const invalid = await fetch(`${base}/api/settings`, {
        method: 'PUT',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...settings, mergeWindowSeconds: 0 }),
      });
      assert.equal(invalid.status, 400);
      assert.equal(data.store.settings.mergeWindowSeconds, 4.5);
      const update = await fetch(`${base}/api/contacts/${data.contact.id}`, {
        method: 'PUT',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...data.contact, qq: '54321' }),
      });
      assert.equal(update.status, 409);
      const profile = {
        name: '测试对象',
        qq: '67890',
        gender: '女',
        bio: '大学同学，平时交流学习。',
        traits: { likes: '阅读', boundaries: '不喜欢催促', communication: '表达直接' },
      };
      const createdResponse = await fetch(`${base}/api/contacts`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify(profile),
      });
      assert.equal(createdResponse.status, 201);
      const created = contactSchema.parse(await createdResponse.json());
      assert.equal(created.gender, profile.gender);
      assert.equal(created.bio, profile.bio);
      assert.deepEqual(created.traits, profile.traits);
      assert.deepEqual(data.store.contact(created.id)?.traits, profile.traits);
      const editedProfile = {
        ...profile,
        gender: '其他',
        traits: { ...profile.traits, likes: '绘画' },
      };
      const editedResponse = await fetch(`${base}/api/contacts/${created.id}`, {
        method: 'PUT',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify(editedProfile),
      });
      assert.equal(editedResponse.status, 200);
      const edited = data.store.contact(created.id);
      assert.equal(edited?.gender, '其他');
      assert.deepEqual(edited?.traits, editedProfile.traits);
      assert.equal(edited?.traitsRevision, created.traitsRevision + 1);
      const invalidGender = await fetch(`${base}/api/contacts/${created.id}`, {
        method: 'PUT',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...editedProfile, gender: 'invalid' }),
      });
      assert.equal(invalidGender.status, 400);
      assert.deepEqual(data.store.contact(created.id), edited);
      const minimalResponse = await fetch(`${base}/api/contacts`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '未填写档案', qq: '67891' }),
      });
      assert.equal(minimalResponse.status, 201);
      const minimal = contactSchema.parse(await minimalResponse.json());
      assert.equal(minimal.gender, '未填写');
      assert.deepEqual(minimal.traits, { likes: '', boundaries: '', communication: '' });
      await fetch(`${base}/api/logout`, { method: 'POST', headers: { Cookie: cookie } });
      assert.equal((await fetch(`${base}/api/state`, { headers: { Cookie: cookie } })).status, 401);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      await application.engine.stop();
      data.cleanup();
    }
  },
);
