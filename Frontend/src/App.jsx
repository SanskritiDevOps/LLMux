import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { lazy } from "react";
import { RouterProvider, createBrowserRouter } from "react-router-dom";
import { AppShell } from "./components/AppShell.jsx";
import { GuestOnly, RequireSession } from "./components/RequireSession.jsx";
import { LoginPage } from "./features/auth/LoginPage.jsx";
import { RegisterPage } from "./features/auth/RegisterPage.jsx";
import { SESSION_KEY } from "./hooks/useSession.js";
import { NotFoundPage } from "./pages/NotFoundPage.jsx";

// Pages behind the login load on first visit, so the login page doesn't download Recharts.
const lazyPage = (load, name) => lazy(() => load().then((module) => ({ default: module[name] })));
const OverviewPage = lazyPage(() => import("./features/overview/OverviewPage.jsx"), "OverviewPage");
const LogsPage = lazyPage(() => import("./features/logs/LogsPage.jsx"), "LogsPage");
const PlaygroundPage = lazyPage(
  () => import("./features/playground/PlaygroundPage.jsx"),
  "PlaygroundPage",
);
const KeysPage = lazyPage(() => import("./features/keys/KeysPage.jsx"), "KeysPage");
const ProvidersPage = lazyPage(
  () => import("./features/providers/ProvidersPage.jsx"),
  "ProvidersPage",
);

// Any 401 means the session has ended (expired, or logged out in another tab): forgetting
// the user makes RequireSession send them to /login.
const onError = (error) => {
  if (error?.status === 401) queryClient.setQueryData(SESSION_KEY, null);
};

const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError }),
  mutationCache: new MutationCache({ onError }),
  defaultOptions: {
    queries: {
      // Retry only what might succeed next time: network errors and server errors.
      retry: (failures, error) => failures < 2 && !(error?.status >= 400 && error?.status < 500),
      refetchOnWindowFocus: false,
    },
  },
});

const router = createBrowserRouter([
  {
    path: "/login",
    element: (
      <GuestOnly>
        <LoginPage />
      </GuestOnly>
    ),
  },
  {
    path: "/register",
    element: (
      <GuestOnly>
        <RegisterPage />
      </GuestOnly>
    ),
  },
  {
    element: (
      <RequireSession>
        <AppShell />
      </RequireSession>
    ),
    children: [
      { path: "/", element: <OverviewPage /> },
      { path: "/logs", element: <LogsPage /> },
      { path: "/playground", element: <PlaygroundPage /> },
      { path: "/keys", element: <KeysPage /> },
      { path: "/providers", element: <ProvidersPage /> },
      { path: "*", element: <NotFoundPage /> },
    ],
  },
]);

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
