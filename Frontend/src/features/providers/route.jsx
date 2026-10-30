import { lazy } from "react";

const ProvidersPage = lazy(() =>
  import("./ProvidersPage.jsx").then((module) => ({ default: module.ProvidersPage })),
);

export const routes = [
  { path: "/providers", element: <ProvidersPage />, nav: { label: "Providers", order: 5 } },
];
