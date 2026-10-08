import { useSyncExternalStore } from "react";

export interface Toast {
  id: number;
  kind: "success" | "error";
  message: string;
}

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function publish(next: Toast[]) {
  toasts = next;
  for (const listener of listeners) listener();
}

function push(kind: Toast["kind"], message: string) {
  const id = nextId++;
  publish([...toasts, { id, kind, message }]);
  setTimeout(() => toast.dismiss(id), kind === "error" ? 8000 : 4000);
}

/** Module-level store so non-React code (the query client) can raise toasts too. */
export const toast = {
  success: (message: string) => push("success", message),
  error: (message: string) => push("error", message),
  dismiss: (id: number) => publish(toasts.filter((t) => t.id !== id)),
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

export const useToasts = () => useSyncExternalStore(subscribe, () => toasts);
