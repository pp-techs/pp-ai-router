import { createModal } from "@buiducnhat/better-modal";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "@/api/client";
import { qk, useAction } from "@/api/queries";
import type { OAuthSession, OAuthStart, Provider } from "@/api/types";
import { CopyButton } from "@/components/copy-button";
import { FormError } from "@/components/form-error";
import { FormField } from "@/components/form-field";
import { ModalDialog } from "@/components/modal-dialog";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { draftToBody, emptyCredentialDraft, type CredentialDraft } from "@/lib/credential-draft";
import { formatDateTime } from "@/lib/format";
import { toast } from "@/lib/toast";
import { CredentialFields } from "./credential-fields";

type Device = Extract<OAuthStart, { flow: "device" }>;
type Paste = Extract<OAuthStart, { flow: "paste" }>;

type Props = { provider: Provider; label: string };

/**
 * Account login for providers whose type supports OAuth: pick settings, start, then follow the
 * device or paste flow. Resolves `true` once the account was added, `false` if dismissed.
 */
export const OAuthModal = createModal<Props, boolean>(
  "oauth-login",
  ({ provider, label, modal }) => (
    <ModalDialog modal={modal} dismissed={false} title={label} wide>
      <OAuthBody
        provider={provider}
        onDone={() => modal.resolve(true)}
        onCancel={() => modal.resolve(false)}
      />
    </ModalDialog>
  ),
);

function OAuthBody({
  provider,
  onDone,
  onCancel,
}: {
  provider: Provider;
  onDone: () => void;
  onCancel: () => void;
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
    onDone();
  }

  return start === null ? (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        begin.mutate();
      }}
    >
      <p className="text-muted-foreground">
        Sign in to an account for <strong className="text-foreground">{provider.id}</strong>. These
        settings apply to the credential it creates.
      </p>
      <CredentialFields
        draft={draft}
        onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))}
        labelRequired={false}
        showEnabled={false}
      />
      <FormError error={begin.error} />
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={begin.isPending}>
          {begin.isPending && <Spinner data-icon="inline-start" />}
          Start sign-in
        </Button>
      </DialogFooter>
    </form>
  ) : start.flow === "device" ? (
    <DeviceFlow start={start} onDone={finished} onRestart={() => setStart(null)} />
  ) : (
    <PasteFlow start={start} onDone={finished} onRestart={() => setStart(null)} />
  );
}

function Failure({ message, onRestart }: { message: string; onRestart: () => void }) {
  return (
    <div className="grid gap-3">
      <FormError error={message} />
      <DialogFooter>
        <Button onClick={onRestart}>Start over</Button>
      </DialogFooter>
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
      <ol className="grid list-decimal gap-1 pl-5 text-muted-foreground">
        <li>
          Open{" "}
          <a
            href={link}
            target="_blank"
            rel="noreferrer noopener"
            className="text-primary underline"
          >
            {start.verification_uri}
          </a>
        </li>
        <li>Enter this code and approve the sign-in:</li>
      </ol>
      <div className="flex items-center justify-center gap-3 rounded-lg bg-muted py-5">
        <code className="text-3xl font-semibold tracking-widest select-all">{start.user_code}</code>
        <CopyButton text={start.user_code} />
      </div>
      <p role="status" className="flex items-center gap-2 text-muted-foreground">
        <Spinner aria-hidden />
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
      <ol className="grid list-decimal gap-1 pl-5 text-muted-foreground">
        <li>
          <a
            href={start.auth_url}
            target="_blank"
            rel="noreferrer noopener"
            className="text-primary underline"
          >
            Open the sign-in page
          </a>{" "}
          and approve access.
        </li>
        <li>{start.instructions}</li>
      </ol>
      <FormField
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
      </FormField>
      <FormError error={complete.error} />
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onRestart}>
          Start over
        </Button>
        <Button type="submit" disabled={complete.isPending}>
          {complete.isPending && <Spinner data-icon="inline-start" />}
          Complete sign-in
        </Button>
      </DialogFooter>
    </form>
  );
}
