import { KeyRoundIcon, PlusIcon } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { qk, useAction } from "@/api/queries";
import type { CreatedKey, VirtualKey } from "@/api/types";
import { PageHeader, Panel } from "@/components/page";
import { ConfirmModal } from "@/components/confirm-modal";
import { EmptyState, QueryBoundary } from "@/components/query-state";
import { Button } from "@/components/ui/button";
import { AddLimitModal } from "./add-limit-dialog";
import { CreateKeyModal } from "./create-key-dialog";
import { CreatedKeyModal } from "./created-key-dialog";
import { EditKeyModal } from "./edit-key-dialog";
import { KeysTable } from "./keys-table";

export function KeysPage() {
  // Usage bars move as requests flow through the router, so poll.
  const queryClient = useQueryClient();
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

  async function rotateKey(key: VirtualKey) {
    const result: { key?: CreatedKey } = {};
    const confirmed = await ConfirmModal.show({
      title: `Rotate ${key.name}?`,
      message:
        "A new secret replaces the current one. Clients using the old secret stop working immediately; limits and usage history are kept.",
      confirmLabel: "Rotate key",
      action: async () => {
        result.key = await api.rotateKey(key.id);
        await queryClient.invalidateQueries({ queryKey: qk.keys });
      },
    });
    if (confirmed && result.key) await CreatedKeyModal.show({ created: result.key, rotated: true });
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
          <Panel flush>
            <KeysTable
              keys={list}
              onEdit={(k) => void EditKeyModal.show({ apiKey: k })}
              onRotate={(k) => void rotateKey(k)}
              onAddLimit={(k) => void AddLimitModal.show({ apiKey: k })}
              onDelete={(k) =>
                void ConfirmModal.show({
                  title: `Delete ${k.name}?`,
                  message:
                    "Clients using this key stop working immediately. Its usage history is kept.",
                  confirmLabel: "Delete key",
                  action: () => remove.mutateAsync(k.id),
                })
              }
            />
          </Panel>
        )}
      </QueryBoundary>
    </>
  );
}
