export class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const message = body && typeof body === 'object' && 'error' in body && typeof body.error === 'string' ? body.error : '请求失败';
    throw new ApiError(response.status, message);
  }
  return response.json();
}
export function send<T>(path: string, value: unknown = {}, method = 'POST'): Promise<T> {
  return api<T>(path, { method, body: JSON.stringify(value) });
}
export const splitList = (value: string): string[] => value.split(/[,，\n]/).map(item => item.trim()).filter(Boolean);
export const formatTime = (value: number): string => new Date(value).toLocaleString('zh-CN', { hour12: false });
