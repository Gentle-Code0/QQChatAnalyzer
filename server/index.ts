import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Store } from './store.js';
import { Application } from './application.js';
import { createApi } from './http.js';

const passwordFile = process.env.APP_PASSWORD_FILE ?? resolve('secrets/app-password.txt');
const password = readFileSync(passwordFile, 'utf8').trim();
const application = new Application(new Store(process.env.DATA_DIR ?? resolve('data')));
const api = createApi(application, password);
const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 无效');
const server = api.listen(port, '0.0.0.0', () => {
  console.info(`ChatAnalyzer API listening on ${port}`);
  application.start();
});
let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  server.close();
  server.closeIdleConnections();
  const deadline = setTimeout(() => {
    console.error('关闭超时');
    process.exit(1);
  }, 10000);
  try {
    await application.stop();
    clearTimeout(deadline);
  } catch {
    console.error('资源清理失败');
    process.exitCode = 1;
    clearTimeout(deadline);
  }
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
