/**
 * Pages register themselves: each src/features/<name>/route.jsx exports
 *
 *   export const routes = [{ path, element, nav?: { label, order }, public?: true }];
 *
 * so adding a page never means editing a central list. `public` routes (login, register)
 * sit outside the app shell and need no session; the rest need one. Routes with `nav`
 * appear in the sidebar, sorted by `order`.
 *
 * App pages should be lazy (React.lazy) so each loads on its first visit; the app shell
 * shows a spinner meanwhile.
 */

const modules = import.meta.glob("./features/*/route.jsx", { eager: true });
const all = Object.values(modules).flatMap((module) => module.routes ?? []);

export const publicRoutes = all.filter((route) => route.public);
export const appRoutes = all.filter((route) => !route.public);

export const navItems = appRoutes
  .filter((route) => route.nav)
  .sort((a, b) => a.nav.order - b.nav.order)
  .map((route) => ({ path: route.path, label: route.nav.label }));
