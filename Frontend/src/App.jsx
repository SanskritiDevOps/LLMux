import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createBrowserRouter } from "react-router-dom";
import { AppShell } from "./components/AppShell.jsx";
import { GuestOnly, RequireSession } from "./components/RequireSession.jsx";
import { SESSION_KEY } from "./hooks/useSession.js";
import { NotFoundPage } from "./pages/NotFoundPage.jsx";
import { appRoutes, publicRoutes } from "./routes.js";

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
  ...publicRoutes.map(({ path, element }) => ({
    path,
    element: <GuestOnly>{element}</GuestOnly>,
  })),
  {
    element: (
      <RequireSession>
        <AppShell />
      </RequireSession>
    ),
    children: [
      ...appRoutes.map(({ path, element }) => ({ path, element })),
      { path: "*", element: <NotFoundPage /> },
    ],
  },
]);

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
