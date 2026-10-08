import { KeyRoundIcon, PlusIcon } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { qk, useAction } from "@/api/queries";
import { PageHeader, Panel } from "@/components/page";
import { ConfirmModal } from "@/components/confirm-modal";
import { EmptyState, QueryBoundary } from "@/components/query-state";
import { Button } from "@/components/ui/button";
import { AddLimitModal } from "./add-limit-dialog";
import { CreateKeyModal } from "./create-key-dialog";
import { CreatedKeyModal } from "./created-key-dialog";
import { KeyCard } from "./key-card";

export function KeysPage() {
  // Usage bars move as requests flow through the router, so poll.
  const keys = useQuery({ queryKey: qk.keys, queryFn: api.keys, refetchInterval: 10_000 });

  const remove = useAction(api.deleteKey, {
    invalidate: [qk.keys],
    inline: true,
    success: "API key deleted.",
  });

  async function createKey() {
    const created = await CreateKeyModal.show();
    if (created) await CreatedKeyModal.show({ created });
  }

  return (
    <>
      <PageHeader
        title="API keys"
        description="Virtual keys handed to clients. Each can restrict models, expire, and carry spend or usage limits."
        actions={
          <Button onClick={() => void createKey()}>
            <PlusIcon data-icon="inline-start" />
            Create key
          </Button>
        }
      />
      <QueryBoundary
        query={keys}
        isEmpty={(list) => list.length === 0}
        empty={
          <Panel>
            <EmptyState
              title="No API keys yet"
              icon={KeyRoundIcon}
              action={
                <Button onClick={() => void createKey()}>
                  <PlusIcon data-icon="inline-start" />
                  Create key
                </Button>
              }
            >
              Create one to start sending requests through the router.
            </EmptyState>
          </Panel>
        }
      >
        {(list) => (
          <div className="grid gap-4">
            {list.map((k) => (
              <KeyCard
                key={k.id}
                apiKey={k}
                onAddLimit={() => void AddLimitModal.show({ apiKey: k })}
                onDelete={() =>
                  void ConfirmModal.show({
                    title: `Delete ${k.name}?`,
                    message:
                      "Clients using this key stop working immediately. Its usage history is kept.",
                    confirmLabel: "Delete key",
                    action: () => remove.mutateAsync(k.id),
                  })
                }
              />
            ))}
          </div>
        )}
      </QueryBoundary>
    </>
  );
}
