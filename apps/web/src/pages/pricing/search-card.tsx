import { useQuery } from "@tanstack/react-query";
import { CoinsIcon, SearchIcon, TagIcon } from "lucide-react";
import { useState, type FormEvent } from "react";
import { api } from "@/api/client";
import { ApiError } from "@/api/http";
import { qk } from "@/api/queries";
import type { Price } from "@/api/types";
import { FormField } from "@/components/form-field";
import { Panel } from "@/components/page";
import { EmptyState, ErrorState, LoadingState, QueryBoundary } from "@/components/query-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useDebounced } from "@/lib/use-debounced";
import { PriceTable } from "./price-table";

/** Effective price of one model: an override wins over fetched prices. */
function Lookup({ onOverride }: { onOverride: (price: Price) => void }) {
  const [text, setText] = useState("");
  const [model, setModel] = useState("");
  const price = useQuery({
    queryKey: qk.priceLookup(model),
    queryFn: () => api.priceLookup(model),
    enabled: model !== "",
    retry: false,
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    setModel(text.trim());
  }

  return (
    <div className="border-b border-border">
      <form onSubmit={submit} className="flex flex-wrap items-end gap-3 bg-muted/30 p-4">
        <FormField
          label="Look up the price billing uses for a model (overrides included)"
          className="min-w-64 flex-1"
        >
          <Input
            value={text}
            placeholder="e.g. gpt-4o-mini"
            onChange={(e) => setText(e.target.value)}
          />
        </FormField>
        <Button type="submit" variant="outline" disabled={text.trim() === ""}>
          <SearchIcon data-icon="inline-start" />
          Look up
        </Button>
      </form>
      {model !== "" &&
        (price.isPending ? (
          <LoadingState />
        ) : price.isError ? (
          price.error instanceof ApiError && price.error.status === 404 ? (
            <p className="px-4 pb-4 text-muted-foreground">
              No price known for <code className="font-mono">{model}</code>; it would be billed at
              $0 and flagged unpriced.
            </p>
          ) : (
            <ErrorState error={price.error} />
          )
        ) : (
          <PriceTable
            prices={[price.data]}
            actions={(p) => [[{ label: "Override", icon: TagIcon, onSelect: () => onOverride(p) }]]}
          />
        ))}
    </div>
  );
}

export function PriceSearchCard({ onOverride }: { onOverride: (price: Price) => void }) {
  const [query, setQuery] = useState("");
  const q = useDebounced(query.trim(), 300);
  const prices = useQuery({
    queryKey: qk.prices(q),
    queryFn: () => api.prices(q),
    // Keep the previous rows on screen while the next search loads, so typing does not flicker.
    placeholderData: (previous) => previous,
  });

  return (
    <Panel
      title="Fetched prices"
      description="Prices synced from upstream catalogs; override any of them."
      flush
    >
      <Lookup onOverride={onOverride} />
      <div className="border-b border-border p-4">
        <FormField label="Search models">
          <Input
            type="search"
            value={query}
            placeholder="e.g. claude, gpt-4o, llama"
            onChange={(e) => setQuery(e.target.value)}
          />
        </FormField>
      </div>
      <QueryBoundary
        query={prices}
        isEmpty={(list) => list.length === 0}
        empty={
          <EmptyState
            icon={CoinsIcon}
            title={q ? `No models match “${q}”` : "No prices fetched yet"}
          >
            {!q && "Run a sync to download the LiteLLM and OpenRouter price lists."}
          </EmptyState>
        }
      >
        {(list) => (
          <PriceTable
            prices={list}
            actions={(p) => [[{ label: "Override", icon: TagIcon, onSelect: () => onOverride(p) }]]}
          />
        )}
      </QueryBoundary>
    </Panel>
  );
}
