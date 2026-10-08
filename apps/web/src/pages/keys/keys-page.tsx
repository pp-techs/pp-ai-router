import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../../api/client.ts";
import { qk, useAction } from "../../api/queries.ts";
import type { CreatedKey, VirtualKey } from "../../api/types.ts";
import { Button } from "../../components/button.tsx";
import { ConfirmDialog } from "../../components/dialog.tsx";
import { Card, PageHeader } from "../../components/page.tsx";
import { EmptyState, QueryBoundary } from "../../components/query-state.tsx";
import { AddLimitDialog } from "./add-limit-dialog.tsx";
import { CreateKeyDialog } from "./create-key-dialog.tsx";
import { CreatedKeyDialog } from "./created-key-dialog.tsx";
import { KeyCard } from "./key-card.tsx";

export function KeysPage() {
  // Usage bars move as requests flow through the router, so poll.
  const keys = useQuery({ queryKey: qk.keys, queryFn: api.keys, refetchInterval: 10_000 });
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedKey | null>(null);
  const [addingLimit, setAddingLimit] = useState<VirtualKey | null>(null);
  const [deleting, setDeleting] = useState<VirtualKey | null>(null);

  const remove = useAction(api.deleteKey, {
    invalidate: [qk.keys],
    success: "API key deleted.",
    onSuccess: () => setDeleting(null),
  });

  return (
    <>
      <PageHeader
        title="API keys"
        description="Virtual keys handed to clients. Each can restrict models, expire, and carry spend or usage limits."
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            Create key
          </Button>
        }
      />
      <QueryBoundary
        query={keys}
        isEmpty={(list) => list.length === 0}
        empty={
          <Card>
            <EmptyState title="No API keys yet">
              Create one to start sending requests through the router.
            </EmptyState>
          </Card>
        }
      >
        {(list) => (
          <div className="grid gap-4">
            {list.map((k) => (
              <KeyCard
                key={k.id}
                apiKey={k}
                onAddLimit={() => setAddingLimit(k)}
                onDelete={() => setDeleting(k)}
              />
            ))}
          </div>
        )}
      </QueryBoundary>

      {creating && (
        <CreateKeyDialog
          onClose={() => setCreating(false)}
          onCreated={(key) => {
            setCreating(false);
            setCreated(key);
          }}
        />
      )}
      {created && <CreatedKeyDialog created={created} onClose={() => setCreated(null)} />}
      {addingLimit && <AddLimitDialog apiKey={addingLimit} onClose={() => setAddingLimit(null)} />}
      {deleting && (
        <ConfirmDialog
          title={`Delete ${deleting.name}?`}
          message="Clients using this key stop working immediately. Its usage history is kept."
          confirmLabel="Delete key"
          loading={remove.isPending}
          onConfirm={() => remove.mutate(deleting.id)}
          onClose={() => setDeleting(null)}
        />
      )}
    </>
  );
}
