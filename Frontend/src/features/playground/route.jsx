import { lazy } from "react";

const PlaygroundPage = lazy(() =>
  import("./PlaygroundPage.jsx").then((module) => ({ default: module.PlaygroundPage })),
);

export const routes = [
  { path: "/playground", element: <PlaygroundPage />, nav: { label: "Playground", order: 3 } },
];
