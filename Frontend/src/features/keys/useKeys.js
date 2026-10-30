import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api/client.js";

const KEYS = ["keys"];

export function useKeys() {
  return useQuery({ queryKey: KEYS, queryFn: ({ signal }) => api("/api/keys", { signal }) });
}

/** A key mutation that refreshes the list (and the Logs key filter) when it succeeds. */
function useKeyMutation(request) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: request,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: KEYS }),
  });
}

/** Resolves to { apiKey, key }: apiKey is the full key, which the API returns only now. */
export const useCreateKey = () =>
  useKeyMutation((body) => api("/api/keys", { method: "POST", body }));

export const useUpdateKey = () =>
  useKeyMutation(({ id, ...body }) => api(`/api/keys/${id}`, { method: "PATCH", body }));

export const useRevokeKey = () =>
  useKeyMutation((id) => api(`/api/keys/${id}`, { method: "DELETE" }));
