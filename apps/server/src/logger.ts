export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

/** One JSON object per line on stdout/stderr; no secrets are ever passed in `fields`. */
export function createLogger(
  write: (line: string) => void = (l) => process.stdout.write(l + "\n"),
): Logger {
  const emit = (level: string) => (msg: string, fields?: Record<string, unknown>) =>
    write(JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields }));
  return { info: emit("info"), warn: emit("warn"), error: emit("error") };
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };
