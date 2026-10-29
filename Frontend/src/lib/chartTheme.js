/** Shared Recharts styling, so every chart looks like part of one system. */

/** The one tooltip style every chart shares. */
export const tooltipProps = {
  contentStyle: {
    background: "#0f172b",
    border: "1px solid #314158",
    borderRadius: 6,
    fontSize: 12,
  },
  labelStyle: { color: "#cad5e2" },
  itemStyle: { color: "#f1f5f9" },
  cursor: { fill: "rgba(148, 163, 184, 0.08)", stroke: "#45556c" },
};

/** Recessive axes and grid: muted ink, no axis lines. */
export const axisProps = {
  stroke: "#62748e",
  tick: { fill: "#90a1b9", fontSize: 12 },
  tickLine: false,
  axisLine: false,
};
