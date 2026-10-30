import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { api } from "../../api/client.js";

export const PAGE_SIZE = 50;

/** Pages of request logs, newest first; each page's nextCursor fetches the next one. */
export function useLogs(filters) {
  return useInfiniteQuery({
    queryKey: ["usage", "logs", filters],
    queryFn: ({ pageParam, signal }) =>
      api("/api/usage/logs", {
        query: { ...filters, limit: PAGE_SIZE, cursor: pageParam },
        signal,
      }),
    initialPageParam: undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
}

/** The user's keys, for the key filter. Shared with the API Keys page's cache. */
export function useKeyOptions() {
  return useQuery({ queryKey: ["keys"], queryFn: ({ signal }) => api("/api/keys", { signal }) });
}
