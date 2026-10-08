import { api } from "@/api/client";
import { qk, useAction } from "@/api/queries";
import type { Credential } from "@/api/types";
import { ConfirmModal } from "@/components/confirm-modal";
import { StatusBadge, type Tone } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { credentialHealth, type CredentialHealth } from "@/lib/credential-health";
import { formatDateTime, formatDuration, formatInt } from "@/lib/format";
import { formatList } from "@/lib/input";
import { EditCredentialModal, ReplaceSecretModal } from "./credential-dialogs";

const HEALTH_TONE: Record<CredentialHealth, Tone> = {
  ready: "ok",
  cooling: "warn",
  dead: "danger",
  disabled: "neutral",
};

export function CredentialsTable({ credentials }: { credentials: Credential[] }) {
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
    inline: true,
  });

  const now = Date.now();
  // Only OAuth accounts have an access-token expiry.
  const showExpiry = credentials.some((c) => c.expires_at !== null);

  return (
    <Table className="min-w-176">
      <TableHeader>
        <TableRow>
          <TableHead>Credential</TableHead>
          <TableHead className="text-right">Weight</TableHead>
          <TableHead className="text-right">Priority</TableHead>
          <TableHead>Models</TableHead>
          <TableHead className="text-right">RPM</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="text-right">In flight</TableHead>
          <TableHead>Cooldown</TableHead>
          {showExpiry && <TableHead>Expires</TableHead>}
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {credentials.map((c) => {
          const health = credentialHealth(c, now);
          return (
            <TableRow key={c.id}>
              <TableCell className="whitespace-nowrap">
                <p className="font-medium">{c.label}</p>
                <p className="mt-0.5 flex items-center gap-1.5">
                  <StatusBadge tone={c.kind === "oauth" ? "accent" : "neutral"}>
                    {c.kind}
                  </StatusBadge>
                  <span className="font-mono text-xs">
                    {c.kind === "oauth" ? (c.account ?? "—") : c.secret_hint}
                  </span>
                </p>
              </TableCell>
              <TableCell className="text-right tabular-nums">{c.weight}</TableCell>
              <TableCell className="text-right tabular-nums">{c.priority}</TableCell>
              <TableCell className="min-w-28 font-mono text-xs whitespace-normal">
                {c.models ? (
                  formatList(c.models)
                ) : (
                  <span className="text-muted-foreground">all</span>
                )}
              </TableCell>
              <TableCell className="text-right tabular-nums">{c.rpm_limit ?? "—"}</TableCell>
              <TableCell className="max-w-56 whitespace-normal">
                <StatusBadge tone={HEALTH_TONE[health]}>{health}</StatusBadge>
                {c.last_error && (
                  <p className="mt-1 text-xs break-words text-destructive" title={c.last_error}>
                    {c.last_error}
                  </p>
                )}
              </TableCell>
              <TableCell className="text-right tabular-nums">{formatInt(c.inflight)}</TableCell>
              <TableCell className="whitespace-nowrap">
                {c.cooldown_until !== null && c.cooldown_until > now
                  ? formatDuration(c.cooldown_until - now)
                  : "—"}
              </TableCell>
              {showExpiry && (
                <TableCell className="text-xs whitespace-nowrap">
                  {c.expires_at === null ? "—" : formatDateTime(c.expires_at)}
                </TableCell>
              )}
              <TableCell>
                <div className="flex justify-end gap-1.5">
                  {c.status === "dead" && (
                    <Button size="sm" onClick={() => revive.mutate(c)}>
                      Revive
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void EditCredentialModal.show({ credential: c })}
                  >
                    Edit
                  </Button>
                  {c.kind === "api_key" && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void ReplaceSecretModal.show({ credential: c })}
                    >
                      Replace secret
                    </Button>
                  )}
                  <Button size="sm" variant="outline" onClick={() => toggle.mutate(c)}>
                    {c.enabled ? "Disable" : "Enable"}
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() =>
                      void ConfirmModal.show({
                        title: `Delete ${c.label}?`,
                        message: "The credential is removed from the pool immediately.",
                        confirmLabel: "Delete credential",
                        action: () => remove.mutateAsync(c),
                      })
                    }
                  >
                    Delete
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
