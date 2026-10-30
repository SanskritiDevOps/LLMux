import { lazy } from "react";

const LogsPage = lazy(() =>
  import("./LogsPage.jsx").then((module) => ({ default: module.LogsPage })),
);

export const routes = [{ path: "/logs", element: <LogsPage />, nav: { label: "Logs", order: 2 } }];
