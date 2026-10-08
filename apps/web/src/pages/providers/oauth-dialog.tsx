import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../../api/client.ts";
import { qk, useAction } from "../../api/queries.ts";
import type { OAuthSession, OAuthStart, Provider } from "../../api/types.ts";
import { Button } from "../../components/button.tsx";
import { CopyButton } from "../../components/copy-button.tsx";
import { Dialog, DialogActions } from "../../components/dialog.tsx";
import { Field, FormError, Textarea } from "../../components/fields.tsx";
import {
  draftToBody,
  emptyCredentialDraft,
  type CredentialDraft,
} from "../../lib/credential-draft.ts";
import { formatDateTime } from "../../lib/format.ts";
import { toast } from "../../lib/toast.ts";
import { CredentialFields } from "./credential-fields.tsx";

type Device = Extract<OAuthStart, { flow: "device" }>;
type Paste = Extract<OAuthStart, { flow: "paste" }>;

/** Account login for providers whose type supports OAuth: pick settings, start, then follow the device or paste flow. */
export function OAuthDialog({
  provider,
  label,
  onClose,
}: {
  provider: Provider;
  label: string;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const [draft, setDraft] = useState<CredentialDraft>(emptyCredentialDraft);
  const [start, setStart] = useState<OAuthStart | null>(null);

  const begin = useAction(
    () => {
      const body = draftToBody(draft);
      return api.startOAuth(provider.id, {
        weight: body.weight,
        priority: body.priority,
        models: body.models,
        rpm_limit: body.rpm_limit,
        ...(body.label && { label: body.label }),
      });
    },
    { inline: true, onSuccess: setStart },
  );

  function finished() {
    void client.invalidateQueries({ queryKey: qk.providers });
    toast.success("Account added.");
    onClose();
  }

  return (
    <Dialog title={label} onClose={onClose} wide>
      {start === null ? (
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            begin.mutate();
          }}
        >
          <p className="text-muted">
            Sign in to an account for <strong className="text-fg">{provider.id}</strong>. These
            settings apply to the credential it creates.
          </p>
          <CredentialFields
            draft={draft}
            onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))}
            labelRequired={false}
            showEnabled={false}
          />
          <FormError error={begin.error} />
          <DialogActions>
            <Button onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" loading={begin.isPending}>
              Start sign-in
            </Button>
          </DialogActions>
        </form>
      ) : start.flow === "device" ? (
        <DeviceFlow start={start} onDone={finished} onRestart={() => setStart(null)} />
      ) : (
        <PasteFlow start={start} onDone={finished} onRestart={() => setStart(null)} />
      )}
    </Dialog>
  );
}

function Failure({ message, onRestart }: { message: string; onRestart: () => void }) {
  return (
    <div className="grid gap-3">
      <FormError error={message} />
      <DialogActions>
        <Button variant="primary" onClick={onRestart}>
          Start over
        </Button>
      </DialogActions>
    </div>
  );
}

const failureOf = (session: OAuthSession | undefined) =>
  session?.status === "error"
    ? session.error
    : session?.status === "expired"
      ? "The sign-in expired before it was completed."
      : null;

function DeviceFlow({
  start,
  onDone,
  onRestart,
}: {
  start: Device;
  onDone: () => void;
  onRestart: () => void;
}) {
  const session = useQuery({
    queryKey: qk.oauthSession(start.session_id),
    queryFn: async () => {
      const result = await api.oauthSession(start.session_id);
      if (result.status === "complete") onDone();
      return result;
    },
    // Honour the provider's polling interval; the server throttles upstream polls itself.
    refetchInterval: (query) =>
      query.state.data && query.state.data.status !== "pending" ? false : start.interval_sec * 1000,
    staleTime: 0,
    gcTime: 0,
  });

  const failure = failureOf(session.data) ?? (session.isError ? session.error.message : null);
  if (failure) return <Failure message={failure} onRestart={onRestart} />;

  const link = start.verification_uri_complete ?? start.verification_uri;
  return (
    <div className="grid gap-4">
      <ol className="grid list-decimal gap-1 pl-5 text-muted">
        <li>
          Open{" "}
          <a
            href={link}
            target="_blank"
            rel="noreferrer noopener"
            className="text-accent underline"
          >
            {start.verification_uri}
          </a>
        </li>
        <li>Enter this code and approve the sign-in:</li>
      </ol>
      <div className="flex items-center justify-center gap-3 rounded-lg bg-subtle py-5">
        <code className="text-3xl font-semibold tracking-widest select-all">{start.user_code}</code>
        <CopyButton text={start.user_code} />
      </div>
      <p role="status" className="flex items-center gap-2 text-muted">
        <span
          aria-hidden
          className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
        />
        Waiting for approval… the code expires {formatDateTime(start.expires_at)}.
      </p>
    </div>
  );
}

function PasteFlow({
  start,
  onDone,
  onRestart,
}: {
  start: Paste;
  onDone: () => void;
  onRestart: () => void;
}) {
  const [input, setInput] = useState("");
  const [expired, setExpired] = useState(false);
  const complete = useAction((text: string) => api.completeOAuth(start.session_id, text), {
    inline: true,
    onSuccess: (session) => {
      if (session.status === "complete") onDone();
      else setExpired(true);
    },
  });

  if (expired)
    return <Failure message="The sign-in expired before it was completed." onRestart={onRestart} />;

  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        complete.mutate(input.trim());
      }}
    >
      <ol className="grid list-decimal gap-1 pl-5 text-muted">
        <li>
          <a
            href={start.auth_url}
            target="_blank"
            rel="noreferrer noopener"
            className="text-accent underline"
          >
            Open the sign-in page
          </a>{" "}
          and approve access.
        </li>
        <li>{start.instructions}</li>
      </ol>
      <Field
        label="Redirect URL or code"
        hint={`This sign-in expires ${formatDateTime(start.expires_at)}.`}
      >
        <Textarea
          required
          rows={3}
          className="font-mono text-xs"
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
      </Field>
      <FormError error={complete.error} />
      <DialogActions>
        <Button onClick={onRestart}>Start over</Button>
        <Button type="submit" variant="primary" loading={complete.isPending}>
          Complete sign-in
        </Button>
      </DialogActions>
    </form>
  );
}
