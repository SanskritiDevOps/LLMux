import { Suspense, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useLogout, useSession } from "../hooks/useSession.js";
import { navItems } from "../routes.js";
import { Button, Spinner } from "./Button.jsx";

function NavItems({ onNavigate }) {
  return (
    <ul className="space-y-1">
      {navItems.map((item) => (
        <li key={item.path}>
          <NavLink
            to={item.path}
            end={item.path === "/"}
            onClick={onNavigate}
            className={({ isActive }) =>
              `flex items-center rounded-md border-l-2 px-3 py-2 text-sm transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${
                isActive
                  ? "border-indigo-400 bg-slate-900 font-medium text-indigo-300"
                  : "border-transparent text-slate-400 hover:bg-slate-900 hover:text-slate-100"
              }`
            }
          >
            {item.label}
          </NavLink>
        </li>
      ))}
    </ul>
  );
}

function UserMenu() {
  const { data: user } = useSession();
  const logout = useLogout();

  return (
    <div className="border-t border-slate-800 pt-4">
      <p className="truncate text-sm font-medium text-slate-100">{user?.name}</p>
      <p className="truncate text-xs text-slate-400">{user?.email}</p>
      <Button
        variant="ghost"
        className="mt-2 -ml-3"
        loading={logout.isPending}
        onClick={() => logout.mutate()}
      >
        Log out
      </Button>
    </div>
  );
}

const Brand = () => (
  <span className="font-mono text-lg font-semibold tracking-tight text-slate-100">LLMux</span>
);

/**
 * Sidebar navigation and content area for every logged-in page. Below `md` the sidebar
 * becomes a top bar with a menu button.
 */
export function AppShell() {
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();
  const [menuPath, setMenuPath] = useState(location.pathname);
  // Navigating (for example with the back button) closes the mobile menu.
  if (menuPath !== location.pathname) {
    setMenuPath(location.pathname);
    setMenuOpen(false);
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 md:flex">
      <aside className="hidden w-56 shrink-0 flex-col border-r border-slate-800 p-4 md:flex">
        <div className="mb-6 px-3">
          <Brand />
        </div>
        <nav aria-label="Main" className="flex-1">
          <NavItems />
        </nav>
        <UserMenu />
      </aside>

      <div className="border-b border-slate-800 md:hidden">
        <div className="flex items-center justify-between p-4">
          <Brand />
          <Button
            variant="ghost"
            aria-expanded={menuOpen}
            aria-controls="mobile-menu"
            onClick={() => setMenuOpen((open) => !open)}
          >
            {menuOpen ? "Close" : "Menu"}
          </Button>
        </div>
        {menuOpen && (
          <nav id="mobile-menu" aria-label="Main" className="space-y-4 px-4 pb-4">
            <NavItems onNavigate={() => setMenuOpen(false)} />
            <UserMenu />
          </nav>
        )}
      </div>

      <main className="min-w-0 flex-1 p-4 md:p-6">
        {/* Pages load on first visit (see routes.js), so charts don't slow down login. */}
        <Suspense fallback={<Spinner className="size-6 text-slate-400" />}>
          <Outlet />
        </Suspense>
      </main>
    </div>
  );
}
