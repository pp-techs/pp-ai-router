export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly extra: Record<string, unknown> | undefined;

  constructor(status: number, code: string, message: string, extra?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

/** OpenAI-style error envelope, shared by the gateway and admin API. */
export function errorBody(code: string, message: string, extra?: Record<string, unknown>) {
  return { error: { message, type: code, code, ...extra } };
}
