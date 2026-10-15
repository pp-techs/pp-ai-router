import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { api } from "@/api/client";
import { qk } from "@/api/queries";
import type { ModelTest, ProviderModelGroup } from "@/api/types";
import type { ModelRow } from "@/lib/models";
import { toast } from "@/lib/toast";

/** Test requests in flight at once: enough to be quick, few enough not to trip a provider's rate limit. */
const CONCURRENCY = 4;

export interface TestRun {
  done: number;
  total: number;
}

export const modelKey = (row: ModelRow) => `${row.provider}/${row.model.id}`;

/**
 * Runs test requests for a list of models, a few at a time, and writes each result into the models
 * query as it arrives. One run at a time; `stop()` lets the requests in flight finish and skips the rest.
 */
export function useModelTests() {
  const client = useQueryClient();
  const [run, setRun] = useState<TestRun | null>(null);
  const [testing, setTesting] = useState<ReadonlySet<string>>(new Set());
  const stopped = useRef(false);

  const record = (row: ModelRow, test: ModelTest) =>
    client.setQueryData<ProviderModelGroup[]>(qk.models, (old) =>
      old?.map((g) =>
        g.provider === row.provider
          ? {
              ...g,
              data: g.data.map((m) => (m.id === row.model.id ? { ...m, last_test: test } : m)),
            }
          : g,
      ),
    );

  async function start(rows: ModelRow[]) {
    if (run || rows.length === 0) return;
    stopped.current = false;
    setRun({ done: 0, total: rows.length });
    const queue = [...rows];
    let ok = 0;
    let failed = 0;
    const apiErrors: string[] = [];

    const worker = async () => {
      for (let row = queue.shift(); row && !stopped.current; row = queue.shift()) {
        const key = modelKey(row);
        setTesting((s) => new Set(s).add(key));
        try {
          const test = await api.testModel(row.provider, row.model.id);
          record(row, test);
          if (test.ok) ok++;
          else failed++;
        } catch (error) {
          // The admin API itself failed (network, session): a model's own failure is a result, not this.
          failed++;
          apiErrors.push(error instanceof Error ? error.message : String(error));
        } finally {
          setTesting((s) => {
            const next = new Set(s);
            next.delete(key);
            return next;
          });
          setRun((r) => r && { ...r, done: r.done + 1 });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, worker));

    setRun(null);
    const tested = ok + failed;
    const summary = `Tested ${tested} model${tested === 1 ? "" : "s"}: ${ok} ok, ${failed} failed${
      stopped.current && tested < rows.length ? ` (stopped, ${rows.length - tested} skipped)` : ""
    }.`;
    if (apiErrors.length > 0) toast.error(`${summary} ${apiErrors[0]}`);
    else toast.success(summary);
  }

  return { run, testing, start, stop: () => (stopped.current = true) };
}
