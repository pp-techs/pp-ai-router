import { MutationCache, QueryClient } from "@tanstack/react-query";
import { ApiError, auth } from "./api/http.ts";
import { toast } from "./lib/toast.ts";

declare module "@tanstack/react-query" {
  interface Register {
    /** `inline`: the calling form renders the error itself, so skip the global toast. */
    mutationMeta: { inline?: boolean };
  }
}

const isClientError = (error: unknown) =>
  error instanceof ApiError && error.status >= 400 && error.status < 500;

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5000,
      retry: (failures, error) => !isClientError(error) && failures < 2,
    },
  },
  mutationCache: new MutationCache({
    onError: (error, _variables, _result, mutation) => {
      // A 401 already sent the user back to the login screen.
      if (mutation.meta?.inline || (error instanceof ApiError && error.status === 401)) return;
      toast.error(error.message);
    },
  }),
});

// Never show one session's data to the next: signing out or a 401 empties the cache.
auth.subscribe(() => {
  if (!auth.token()) queryClient.clear();
});
