import { useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api } from "../../api/client.ts";
import { qk, useAction } from "../../api/queries.ts";
import type { Provider } from "../../api/types.ts";
import { Badge } from "../../components/badge.tsx";
import { Button } from "../../components/button.tsx";
import { ConfirmDialog } from "../../components/dialog.tsx";
import { Card, PageHeader } from "../../components/page.tsx";
import { EmptyState, QueryBoundary } from "../../components/query-state.tsx";
import { AddCredentialDialog } from "./credential-dialogs.tsx";
import { CredentialsTable } from "./credentials-table.tsx";
import { AliasDialog } from "../alias-dialog.tsx";
import { ModelsCard } from "./models-card.tsx";
import { OAuthDialog } from "./oauth-dialog.tsx";
import { EditProviderDialog } from "./provider-dialogs.tsx";

type Dialog = "edit" | "delete" | "add-key" | "oauth" | null;

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium text-muted">{label}</dt>
      <dd className="mt-0.5 break-all">{children}</dd>
    </div>
  );
}

export function ProviderDetailPage() {
  const id = useParams().id ?? "";
  const providers = useQuery({ queryKey: qk.providers, queryFn: api.providers });
  const provider = providers.data?.find((p) => p.id === id);

  return (
    <>
      <Link to="/providers" className="mb-3 inline-block text-muted hover:text-fg">
        ← Providers
      </Link>
      <QueryBoundary
        query={providers}
        isEmpty={() => provider === undefined}
        empty={<EmptyState title={`No provider "${id}"`}>It may have been deleted.</EmptyState>}
      >
        {(list) => provider && <ProviderView provider={provider} providers={list} />}
      </QueryBoundary>
    </>
  );
}

function ProviderView({ provider, providers }: { provider: Provider; providers: Provider[] }) {
  const navigate = useNavigate();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [aliasModel, setAliasModel] = useState<string | null>(null);
  const close = () => setDialog(null);

  const types = useQuery({ queryKey: qk.providerTypes, queryFn: api.providerTypes });
  const type = types.data?.find((t) => t.type === provider.type);
  // Inflight counts and cooldowns are live state, so keep the table fresh.
  const credentials = useQuery({
    queryKey: qk.credentials(provider.id),
    queryFn: () => api.credentials(provider.id),
    refetchInterval: 10_000,
  });

  const toggle = useAction(() => api.updateProvider(provider.id, { enabled: !provider.enabled }), {
    invalidate: [qk.providers],
  });
  const remove = useAction(() => api.deleteProvider(provider.id), {
    invalidate: [qk.providers],
    success: "Provider deleted.",
    onSuccess: () => void navigate("/providers"),
  });

  return (
    <>
      <PageHeader
        title={provider.id}
        description={type?.label ?? provider.type}
        actions={
          <>
            <Button onClick={() => setDialog("edit")}>Edit settings</Button>
            <Button onClick={() => toggle.mutate()} loading={toggle.isPending}>
              {provider.enabled ? "Disable" : "Enable"}
            </Button>
            <Button variant="danger" onClick={() => setDialog("delete")}>
              Delete
            </Button>
          </>
        }
      />

      <Card className="mb-6">
        <dl className="grid grid-cols-2 gap-4 lg:grid-cols-5">
          <Detail label="Status">
            <Badge tone={provider.enabled ? "ok" : "neutral"}>
              {provider.enabled ? "enabled" : "disabled"}
            </Badge>
          </Detail>
          <Detail label="Base URL">
            <span className="font-mono text-xs">{provider.base_url}</span>
          </Detail>
          <Detail label="Strategy">{provider.key_strategy}</Detail>
          <Detail label="Sticky TTL">
            {provider.sticky_ttl_sec === 0 ? "off" : `${provider.sticky_ttl_sec}s`}
          </Detail>
          <Detail label="Max attempts">{provider.max_key_attempts}</Detail>
        </dl>
      </Card>

      <Card
        title="Credentials"
        flush
        actions={
          <>
            {provider.oauth && (
              <Button small onClick={() => setDialog("oauth")}>
                {type?.oauth?.label ?? "Sign in with account"}
              </Button>
            )}
            <Button small variant="primary" onClick={() => setDialog("add-key")}>
              Add API key
            </Button>
          </>
        }
      >
        <QueryBoundary
          query={credentials}
          isEmpty={(list) => list.length === 0}
          empty={
            <EmptyState title="No credentials">
              This provider cannot serve requests until it has at least one.
            </EmptyState>
          }
        >
          {(list) => <CredentialsTable credentials={list} />}
        </QueryBoundary>
      </Card>

      <div className="mt-6">
        <ModelsCard provider={provider} type={type} onCreateAlias={setAliasModel} />
      </div>

      {aliasModel !== null && (
        <AliasDialog
          alias={null}
          firstTarget={{ provider: provider.id, model: aliasModel }}
          providers={providers}
          onClose={() => setAliasModel(null)}
        />
      )}
      {dialog === "edit" && <EditProviderDialog provider={provider} onClose={close} />}
      {dialog === "add-key" && <AddCredentialDialog providerId={provider.id} onClose={close} />}
      {dialog === "oauth" && (
        <OAuthDialog
          provider={provider}
          label={type?.oauth?.label ?? "Sign in with account"}
          onClose={close}
        />
      )}
      {dialog === "delete" && (
        <ConfirmDialog
          title={`Delete ${provider.id}?`}
          message="Its credentials are deleted with it and aliases pointing here stop resolving. Usage history is kept."
          confirmLabel="Delete provider"
          loading={remove.isPending}
          onConfirm={() => remove.mutate()}
          onClose={close}
        />
      )}
    </>
  );
}
