export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const UNAUTHORIZED_EVENT = 'homeport:unauthorized';

export async function api<T = unknown>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'X-Homeport': '1' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  if (res.status === 401 && url !== '/api/login') window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  if (!res.ok) throw new ApiError(res.status, json.error ?? res.statusText);
  return json as T;
}

export const get = <T>(url: string) => api<T>('GET', url);
export const post = <T = unknown>(url: string, body?: unknown) => api<T>('POST', url, body);
export const put = <T = unknown>(url: string, body?: unknown) => api<T>('PUT', url, body);
export const del = <T = unknown>(url: string) => api<T>('DELETE', url);
