import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api } from "@/api/client";
import { qk, useAction } from "@/api/queries";
import type { Provider } from "@/api/types";
import { ConfirmModal } from "@/components/confirm-modal";
import { PageHeader, Panel } from "@/components/page";
import { EmptyState, QueryBoundary } from "@/components/query-state";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { AliasModal } from "../alias-dialog";
import { AddCredentialModal } from "./credential-dialogs";
import { CredentialsTable } from "./credentials-table";
import { ModelsCard } from "./models-card";
import { OAuthModal } from "./oauth-dialog";
import { EditProviderModal } from "./provider-dialogs";
import { QuotaCard } from "./quota-card";

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
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
      <Link
        to="/providers"
        className="mb-3 inline-block text-muted-foreground hover:text-foreground"
      >
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
    inline: true,
    onSuccess: () => void navigate("/providers"),
  });

  return (
    <>
      <PageHeader
        title={provider.id}
        description={type?.label ?? provider.type}
        actions={
          <>
            <Button variant="outline" onClick={() => void EditProviderModal.show({ provider })}>
              Edit settings
            </Button>
            <Button variant="outline" disabled={toggle.isPending} onClick={() => toggle.mutate()}>
              {toggle.isPending && <Spinner data-icon="inline-start" />}
              {provider.enabled ? "Disable" : "Enable"}
            </Button>
            <Button
              variant="destructive"
              onClick={() =>
                void ConfirmModal.show({
                  title: `Delete ${provider.id}?`,
                  message:
                    "Its credentials are deleted with it and aliases pointing here stop resolving. Usage history is kept.",
                  confirmLabel: "Delete provider",
                  action: () => remove.mutateAsync(),
                })
              }
            >
              Delete
            </Button>
          </>
        }
      />

      <Panel className="mb-6">
        <dl className="grid grid-cols-2 gap-4 lg:grid-cols-5">
          <Detail label="Status">
            <StatusBadge tone={provider.enabled ? "ok" : "neutral"}>
              {provider.enabled ? "enabled" : "disabled"}
            </StatusBadge>
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
      </Panel>

      <Panel
        title="Credentials"
        flush
        actions={
          <>
            {provider.oauth && (
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  void OAuthModal.show({
                    provider,
                    label: type?.oauth?.label ?? "Sign in with account",
                  })
                }
              >
                {type?.oauth?.label ?? "Sign in with account"}
              </Button>
            )}
            <Button
              size="sm"
              onClick={() => void AddCredentialModal.show({ providerId: provider.id })}
            >
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
      </Panel>

      {type?.quota && (
        <div className="mt-6">
          <QuotaCard provider={provider} />
        </div>
      )}

      <div className="mt-6">
        <ModelsCard
          provider={provider}
          type={type}
          onCreateAlias={(model) =>
            void AliasModal.show({
              alias: null,
              firstTarget: { provider: provider.id, model },
              providers,
            })
          }
        />
      </div>
    </>
  );
}
