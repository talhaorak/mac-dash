/**
 * Access token for servers that listen beyond loopback (docs/backend-contract.md, "Access token").
 * A loopback server and the desktop app need none.
 */

const KEY = "macdash.token";
export const UNAUTHORIZED_EVENT = "macdash:unauthorized";

export function getToken(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(KEY, token);
    else localStorage.removeItem(KEY);
  } catch {
    // Private mode: the token lives for this page only.
  }
}

export function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Appends the token to a WebSocket URL. Browsers cannot set headers on a WebSocket. */
export function withToken(url: string): string {
  const token = getToken();
  return token ? `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}` : url;
}

/** Every 401 from the API ends here, so the login screen appears wherever it happened. */
export function reportUnauthorized(): void {
  window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
}
