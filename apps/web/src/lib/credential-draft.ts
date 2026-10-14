import type { Credential, CredentialCreate } from "../api/types.ts";
import { headerMap, headerRows, type HeaderRow } from "./headers.ts";
import { formatList, optionalNumber, parseList } from "./input.ts";

/** Credential form state: numbers stay text until submit so inputs can be blank while typing. */
export interface CredentialDraft {
  label: string;
  weight: string;
  priority: string;
  models: string;
  rpm: string;
  enabled: boolean;
  headers: HeaderRow[];
}

export const emptyCredentialDraft = (): CredentialDraft => ({
  label: "",
  weight: "1",
  priority: "0",
  models: "",
  rpm: "",
  enabled: true,
  headers: [],
});

export const draftFromCredential = (c: Credential): CredentialDraft => ({
  label: c.label,
  weight: String(c.weight),
  priority: String(c.priority),
  models: formatList(c.models),
  rpm: c.rpm_limit === null ? "" : String(c.rpm_limit),
  enabled: c.enabled,
  headers: headerRows(c.headers),
});

/** Everything but the secret; the inputs' native min/max have already validated the numbers. */
export function draftToBody(draft: CredentialDraft): Omit<CredentialCreate, "secret"> {
  return {
    label: draft.label.trim(),
    weight: Number(draft.weight),
    priority: Number(draft.priority),
    models: parseList(draft.models),
    rpm_limit: optionalNumber(draft.rpm),
    enabled: draft.enabled,
    headers: headerMap(draft.headers),
  };
}
