const TOKEN_KEY = 'loc.token';

/**
 * First visit: lift `?token=` out of the URL into sessionStorage and scrub it from the address bar.
 * Later reads come from sessionStorage. Empty string means no token is available.
 */
export function getToken(): string {
  try {
    const url = new URL(location.href);
    const fromUrl = url.searchParams.get('token');
    if (fromUrl) {
      sessionStorage.setItem(TOKEN_KEY, fromUrl);
      url.searchParams.delete('token');
      history.replaceState(null, '', url.pathname + url.search + url.hash);
      return fromUrl;
    }
    return sessionStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

/** Authenticated JSON request against `/api`. Non-2xx throws an Error carrying the server's `{ error }` text. */
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  if (!token) throw new Error('沒有存取令牌，請用伺服器印出的網址開啟');
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  if (init.body !== undefined && init.body !== null && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const res = await fetch(`/api${path}`, { ...init, headers });
  if (!res.ok) {
    let message = `請求失敗（${res.status}）`;
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === 'string' && body.error) message = body.error;
    } catch {
      // body was not JSON; keep the status message
    }
    throw new Error(message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
