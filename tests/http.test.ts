import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Application } from '../server/application.js';
import { createApi } from '../server/http.js';
import { fixture } from './helpers.js';

test(
  'API 要求认证、拒绝跨来源写入，状态不暴露密钥；档案绑定不可换号',
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
