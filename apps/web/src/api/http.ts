const TOKEN_KEY = "pp-admin-token";
const listeners = new Set<() => void>();

const getToken = () => sessionStorage.getItem(TOKEN_KEY);

function notify() {
  for (const listener of listeners) listener();
}

function setToken(token: string) {
  sessionStorage.setItem(TOKEN_KEY, token);
  notify();
}

function clearToken() {
  sessionStorage.removeItem(TOKEN_KEY);
  notify();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** The admin token lives in sessionStorage: it dies with the tab and is never written to disk. */
export const auth = { token: getToken, set: setToken, clear: clearToken, subscribe };

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

type Query = Record<string, string | number | undefined>;

interface RequestOptions {
  body?: unknown;
  query?: Query;
  /** Use this token instead of the stored one (the login screen checks a token before keeping it). */
  token?: string;
}

function withQuery(path: string, query: Query | undefined): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `${path}?${text}` : path;
}

async function errorFrom(response: Response): Promise<ApiError> {
  const body: unknown = await response.json().catch(() => undefined);
  const error = (body as { error?: { code?: unknown; message?: unknown } } | undefined)?.error;
  const code = typeof error?.code === "string" ? error.code : "http_error";
  const message =
    typeof error?.message === "string"
      ? error.message
      : `Request failed (HTTP ${response.status}).`;
  return new ApiError(response.status, code, message);
}

/** JSON request against the admin API. A 401 drops the stored token so the app returns to the login screen. */
export async function request<T>(
  method: string,
  path: string,
  { body, query, token = auth.token() ?? undefined }: RequestOptions = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";

  let response: Response;
  try {
    response = await fetch(withQuery(path, query), {
      method,
      headers,
      body: body === undefined ? null : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "network_error", "Cannot reach the router. Check that the server is up.");
  }

  if (response.status === 401) auth.clear();
  if (!response.ok) throw await errorFrom(response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}
