import { lazy } from "react";

const OverviewPage = lazy(() =>
  import("./OverviewPage.jsx").then((module) => ({ default: module.OverviewPage })),
);

export const routes = [
  { path: "/", element: <OverviewPage />, nav: { label: "Overview", order: 1 } },
];
