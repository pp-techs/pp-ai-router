/** "a, b\nc" -> ["a","b","c"]; blank input -> null (the API's "no restriction"). */
export function parseList(text: string): string[] | null {
  const items = text
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : null;
}

export const formatList = (list: string[] | null) => (list ?? []).join(", ");

const pad = (n: number) => String(n).padStart(2, "0");

/** Epoch ms -> value of an `<input type="datetime-local">` (browser-local time). */
export function toDatetimeLocal(ms: number | null): string {
  if (ms === null) return "";
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromDatetimeLocal(value: string): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/** Optional numeric field (range checks are the input's native `min`/`max`): blank -> null. */
export const optionalNumber = (text: string) => (text.trim() === "" ? null : Number(text));
