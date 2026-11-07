import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

/** Password never enters SQLite. Sessions and login throttling are bounded and process-local. */
export class Auth {
  private readonly sessions = new Map<string, number>();
  private readonly attempts = new Map<string, { count: number; expires: number }>();
  constructor(private readonly password: string) {
    if (password.length < 12) throw new Error('访问密码至少需要 12 个字符');
  }
  login(request: Request, response: Response): void {
    const now = Date.now();
    for (const [key, value] of this.attempts) if (value.expires < now) this.attempts.delete(key);
    for (const [key, expires] of this.sessions) if (expires < now) this.sessions.delete(key);
    const address = request.ip ?? 'unknown';
    const attempt = this.attempts.get(address) ?? { count: 0, expires: now + 60000 };
    if (attempt.count >= 10 || this.attempts.size > 10000) { response.status(429).json({ error: '尝试过多，请稍后重试' }); return; }
    attempt.count++;
    this.attempts.set(address, attempt);
    const supplied: unknown = request.body?.password;
    const expectedHash = createHash('sha256').update(this.password).digest();
    const actualHash = createHash('sha256').update(typeof supplied === 'string' ? supplied : '').digest();
    if (!timingSafeEqual(expectedHash, actualHash)) { response.status(401).json({ error: '访问密码错误' }); return; }
    if (this.sessions.size >= 1000) { response.status(429).json({ error: '会话数量达到上限' }); return; }
    this.attempts.delete(address);
    const token = randomBytes(32).toString('hex');
    this.sessions.set(token, now + 86400000);
    response.cookie('session', token, { httpOnly: true, sameSite: 'strict', maxAge: 86400000, secure: request.secure, path: '/api' });
    response.json({ ok: true });
  }
  private token(request: Request): string {
    return /(?:^|;\s*)session=([a-f0-9]{64})(?:;|$)/.exec(request.headers.cookie ?? '')?.[1] ?? '';
  }
  require = (request: Request, response: Response, next: NextFunction): void => {
    const token = this.token(request);
    if ((this.sessions.get(token) ?? 0) <= Date.now()) {
      this.sessions.delete(token);
      response.status(401).json({ error: '请先登录' }); return;
    }
    next();
  };
  logout(request: Request, response: Response): void {
    this.sessions.delete(this.token(request));
    response.clearCookie('session', { path: '/api' }).json({ ok: true });
  }
}

/** Browser writes must originate from the same origin; non-browser clients use the session cookie. */
export function sameOrigin(request: Request, response: Response, next: NextFunction): void {
  const origin = request.headers.origin;
  if (origin && origin !== `${request.protocol}://${request.get('host')}`) {
    response.status(403).json({ error: '拒绝跨来源请求' }); return;
  }
  if (request.headers['sec-fetch-site'] === 'cross-site') {
    response.status(403).json({ error: '拒绝跨站请求' }); return;
  }
  next();
}
