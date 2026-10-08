/** Persisted OAuth state of one upstream account. Times are epoch ms. */
export interface OAuthTokens {
  accessToken: string;
  refreshToken: string | null;
  /** null = the access token does not expire (or the provider never says). */
  expiresAt: number | null;
  /** Human label for the account (usually an email), shown in the admin UI. */
  account?: string | undefined;
  /** Provider-specific string fields that must survive refreshes (project id, profile ARN, region, client id...). */
  extra: Record<string, string>;
}

export type CredentialAuth =
  | { type: "api_key"; key: string }
  | { type: "oauth"; tokens: OAuthTokens };

/**
 * How a login is presented to an admin using a browser on a different machine than the router:
 * - `device`: show `userCode` + `verificationUri`; the router polls until the user approves.
 * - `paste`: show `authUrl`; the user signs in, then pastes the final redirect URL (or code) back.
 */
export type LoginStartInfo =
  | {
      flow: "device";
      verificationUri: string;
      verificationUriComplete?: string | undefined;
      userCode: string;
      intervalSec: number;
      expiresAt: number;
    }
  | { flow: "paste"; authUrl: string; instructions: string; expiresAt: number };

export type PollResult =
  | { status: "pending" }
  | { status: "complete"; tokens: OAuthTokens }
  | { status: "error"; message: string };

export interface OAuthProvider<State = unknown> {
  /** Shown in the admin UI, e.g. "Sign in with Kiro". */
  readonly label: string;
  start(): Promise<{ info: LoginStartInfo; state: State }>;
  /** Required for `device` flows. Must return `pending` while the user has not approved yet. */
  poll?(state: State): Promise<PollResult>;
  /** Required for `paste` flows. `input` is whatever the user pasted (full redirect URL or bare code). */
  complete?(state: State, input: string): Promise<OAuthTokens>;
  /** Throws `OAuthRefreshError` (terminal when the account must be re-authorised). */
  refresh(tokens: OAuthTokens): Promise<OAuthTokens>;
}

export class OAuthRefreshError extends Error {
  readonly terminal: boolean;

  constructor(message: string, terminal: boolean, options?: ErrorOptions) {
    super(message, options);
    this.terminal = terminal;
  }
}
