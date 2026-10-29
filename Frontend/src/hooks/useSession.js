import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client.js";

export const SESSION_KEY = ["session"];

/** The logged-in user, null when logged out (the API answers 401), or a network error. */
async function fetchSession() {
  try {
    const { user } = await api("/api/auth/me");
    return user;
  } catch (err) {
    if (err.status === 401) return null;
    throw err;
  }
}

export function useSession() {
  return useQuery({ queryKey: SESSION_KEY, queryFn: fetchSession, staleTime: 5 * 60_000 });
}

/** Logs in or registers, then remembers the user so the app doesn't ask the API again. */
export function useAuthMutation(path) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body) => api(path, { method: "POST", body }),
    onSuccess: ({ user }) => queryClient.setQueryData(SESSION_KEY, user),
  });
}

/** Clears the cookie, forgets every cached response, and goes to the login page. */
export function useLogout() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: () => api("/api/auth/logout", { method: "POST" }),
    onSettled: () => {
      queryClient.clear();
      queryClient.setQueryData(SESSION_KEY, null);
      navigate("/login", { replace: true });
    },
  });
}
