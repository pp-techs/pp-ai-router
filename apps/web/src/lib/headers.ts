/** One row of the custom-header editor: text until submit, like `CredentialDraft`'s numbers. */
export interface HeaderRow {
  name: string;
  value: string;
}

export const emptyHeaderRow = (): HeaderRow => ({ name: "", value: "" });

/** A stored map -> editor rows, in insertion order. */
export const headerRows = (headers: Readonly<Record<string, string>>): HeaderRow[] =>
  Object.entries(headers).map(([name, value]) => ({ name, value }));

/**
 * Editor rows -> the API's map. Blank rows are dropped, names and values trimmed, and on a repeated
 * name the last row wins (the server sees one object, so this is what an earlier row would mean).
 */
export function headerMap(rows: readonly HeaderRow[]): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const row of rows) {
    const name = row.name.trim();
    if (name === "") continue;
    headers[name] = row.value.trim();
  }
  return headers;
}
