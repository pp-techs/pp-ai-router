import { useState } from "react";
import { api } from "../../api/client.ts";
import { qk, useAction } from "../../api/queries.ts";
import type { Credential } from "../../api/types.ts";
import { Badge, type Tone } from "../../components/badge.tsx";
import { Button } from "../../components/button.tsx";
import { ConfirmDialog } from "../../components/dialog.tsx";
import { Table, Td, Th, Tr } from "../../components/table.tsx";
import { credentialHealth, type CredentialHealth } from "../../lib/credential-health.ts";
import { formatDateTime, formatDuration, formatInt } from "../../lib/format.ts";
import { formatList } from "../../lib/input.ts";
import { EditCredentialDialog, ReplaceSecretDialog } from "./credential-dialogs.tsx";

const HEALTH_TONE: Record<CredentialHealth, Tone> = {
  ready: "ok",
  cooling: "warn",
  dead: "danger",
  disabled: "neutral",
};

type Dialog = { kind: "edit" | "secret" | "delete"; credential: Credential } | null;

export function CredentialsTable({ credentials }: { credentials: Credential[] }) {
  const [dialog, setDialog] = useState<Dialog>(null);
  const close = () => setDialog(null);

  const toggle = useAction((c: Credential) => api.updateCredential(c.id, { enabled: !c.enabled }), {
    invalidate: [qk.providers],
  });
  const revive = useAction((c: Credential) => api.updateCredential(c.id, { status: "active" }), {
    invalidate: [qk.providers],
    success: "Credential revived.",
  });
  const remove = useAction((c: Credential) => api.deleteCredential(c.id), {
    invalidate: [qk.providers],
    success: "Credential deleted.",
    onSuccess: close,
  });

  const now = Date.now();
  // Only OAuth accounts have an access-token expiry.
  const showExpiry = credentials.some((c) => c.expires_at !== null);

  return (
    <>
      <Table wide>
        <thead>
          <tr>
            <Th>Credential</Th>
            <Th className="text-right">Weight</Th>
            <Th className="text-right">Priority</Th>
            <Th>Models</Th>
            <Th className="text-right">RPM</Th>
            <Th>Status</Th>
            <Th className="text-right">In flight</Th>
            <Th>Cooldown</Th>
            {showExpiry && <Th>Expires</Th>}
            <Th className="text-right">Actions</Th>
          </tr>
        </thead>
        <tbody>
          {credentials.map((c) => {
            const health = credentialHealth(c, now);
            return (
              <Tr key={c.id}>
                <Td className="whitespace-nowrap">
                  <p className="font-medium">{c.label}</p>
                  <p className="mt-0.5 flex items-center gap-1.5">
                    <Badge tone={c.kind === "oauth" ? "accent" : "neutral"}>{c.kind}</Badge>
                    <span className="font-mono text-xs">
                      {c.kind === "oauth" ? (c.account ?? "—") : c.secret_hint}
                    </span>
                  </p>
                </Td>
                <Td className="text-right tabular-nums">{c.weight}</Td>
                <Td className="text-right tabular-nums">{c.priority}</Td>
                <Td className="min-w-28 font-mono text-xs">
                  {c.models ? formatList(c.models) : <span className="text-muted">all</span>}
                </Td>
                <Td className="text-right tabular-nums">{c.rpm_limit ?? "—"}</Td>
                <Td className="max-w-56">
                  <Badge tone={HEALTH_TONE[health]}>{health}</Badge>
                  {c.last_error && (
                    <p className="mt-1 text-xs break-words text-danger" title={c.last_error}>
                      {c.last_error}
                    </p>
                  )}
                </Td>
                <Td className="text-right tabular-nums">{formatInt(c.inflight)}</Td>
                <Td className="whitespace-nowrap">
                  {c.cooldown_until !== null && c.cooldown_until > now
                    ? formatDuration(c.cooldown_until - now)
                    : "—"}
                </Td>
                {showExpiry && (
                  <Td className="text-xs whitespace-nowrap">
                    {c.expires_at === null ? "—" : formatDateTime(c.expires_at)}
                  </Td>
                )}
                <Td>
                  <div className="flex justify-end gap-1.5">
                    {c.status === "dead" && (
                      <Button small variant="primary" onClick={() => revive.mutate(c)}>
                        Revive
                      </Button>
                    )}
                    <Button small onClick={() => setDialog({ kind: "edit", credential: c })}>
                      Edit
                    </Button>
                    {c.kind === "api_key" && (
                      <Button small onClick={() => setDialog({ kind: "secret", credential: c })}>
                        Replace secret
                      </Button>
                    )}
                    <Button small onClick={() => toggle.mutate(c)}>
                      {c.enabled ? "Disable" : "Enable"}
                    </Button>
                    <Button
                      small
                      variant="danger"
                      onClick={() => setDialog({ kind: "delete", credential: c })}
                    >
                      Delete
                    </Button>
                  </div>
                </Td>
              </Tr>
            );
          })}
        </tbody>
      </Table>

      {dialog?.kind === "edit" && (
        <EditCredentialDialog credential={dialog.credential} onClose={close} />
      )}
      {dialog?.kind === "secret" && (
        <ReplaceSecretDialog credential={dialog.credential} onClose={close} />
      )}
      {dialog?.kind === "delete" && (
        <ConfirmDialog
          title={`Delete ${dialog.credential.label}?`}
          message="The credential is removed from the pool immediately."
          confirmLabel="Delete credential"
          loading={remove.isPending}
          onConfirm={() => remove.mutate(dialog.credential)}
          onClose={close}
        />
      )}
    </>
  );
}
