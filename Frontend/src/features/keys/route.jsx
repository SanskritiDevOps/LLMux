import { lazy } from "react";

const KeysPage = lazy(() =>
  import("./KeysPage.jsx").then((module) => ({ default: module.KeysPage })),
);

// Order 4: Playground (Day 15) takes 3.
export const routes = [
  { path: "/keys", element: <KeysPage />, nav: { label: "API Keys", order: 4 } },
];
