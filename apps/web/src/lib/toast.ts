import { toast as manager } from "@/components/ui/toast";

/** App-wide notifications; module-level so non-React code (the query client) can raise them too. */
export const toast = {
  success: (message: string) =>
    manager.add({ description: message, type: "success", timeout: 4000 }),
  error: (message: string) => manager.add({ description: message, type: "error", timeout: 8000 }),
};
