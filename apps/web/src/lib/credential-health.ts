import type { Credential } from "../api/types.ts";

export type CredentialHealth = "ready" | "cooling" | "dead" | "disabled";

/** What the pool will do with a credential right now. A dead credential stays dead until revived. */
export function credentialHealth(credential: Credential, now: number): CredentialHealth {
  if (credential.status === "dead") return "dead";
  if (!credential.enabled) return "disabled";
  if (credential.cooldown_until !== null && credential.cooldown_until > now) return "cooling";
  return "ready";
}

export type ProviderHealth = "healthy" | "degraded" | "unavailable" | "no credentials" | "disabled";

export interface HealthSummary {
  state: ProviderHealth;
  counts: Record<CredentialHealth, number>;
}

/** Roll a provider's credentials up: usable now (ready) vs. cooling, dead or switched off. */
export function summarizeHealth(
  providerEnabled: boolean,
  credentials: Credential[],
  now: number,
): HealthSummary {
  const counts: Record<CredentialHealth, number> = { ready: 0, cooling: 0, dead: 0, disabled: 0 };
  for (const credential of credentials) counts[credentialHealth(credential, now)]++;

  let state: ProviderHealth;
  if (!providerEnabled) state = "disabled";
  else if (credentials.length === 0) state = "no credentials";
  else if (counts.ready === 0 && counts.cooling === 0) state = "unavailable";
  else if (counts.ready === credentials.length) state = "healthy";
  else state = "degraded";
  return { state, counts };
}
