import { Navigate, useLocation } from "react-router-dom";
import { useSession } from "../hooks/useSession.js";
import { Spinner } from "./Button.jsx";
import { ErrorNotice } from "./ErrorNotice.jsx";

function FullScreen({ children }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-950 p-4 text-slate-400">
      {children}
    </div>
  );
}

/**
 * Renders its children only for a logged-in user. A logged-out visitor goes to /login,
 * which sends them back here (`state.from`) after logging in.
 */
export function RequireSession({ children }) {
  const session = useSession();
  const location = useLocation();

  if (session.isPending) {
    return (
      <FullScreen>
        <Spinner className="size-6" />
        <span className="sr-only">Loading</span>
      </FullScreen>
    );
  }
  if (session.isError) {
    return (
      <FullScreen>
        <ErrorNotice
          error={session.error}
          title="Couldn't check your session"
          onRetry={() => session.refetch()}
          className="max-w-md"
        />
      </FullScreen>
    );
  }
  if (!session.data) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }
  return children;
}

/** Login and register pages: a user who is already logged in goes straight to the app. */
export function GuestOnly({ children }) {
  const session = useSession();
  if (session.data) return <Navigate to="/" replace />;
  return children;
}
