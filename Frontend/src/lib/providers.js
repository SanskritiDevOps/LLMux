/**
 * Each provider keeps one colour everywhere (docs/Design.md section 2).
 *
 * `text` (Tailwind 400 steps) is for badges and labels. `chart` is for chart marks on the
 * dark surface: the 400 steps are too light for fills there, so charts use the darker
 * steps of the same hues, which pass the colour-blind separation and contrast checks
 * against slate-900.
 */
export const PROVIDER_COLORS = {
  gemini: { label: "Gemini", text: "text-sky-400", dot: "bg-sky-400", chart: "#0084d1" },
  openai: { label: "OpenAI", text: "text-emerald-400", dot: "bg-emerald-400", chart: "#009966" },
  anthropic: {
    label: "Anthropic",
    text: "text-orange-400",
    dot: "bg-orange-400",
    chart: "#f54900",
  },
  ollama: { label: "Ollama", text: "text-violet-400", dot: "bg-violet-400", chart: "#8e51ff" },
};

const UNKNOWN = { label: "Unknown", text: "text-slate-400", dot: "bg-slate-500", chart: "#62748e" };

export const providerStyle = (provider) => PROVIDER_COLORS[provider] ?? UNKNOWN;

/** One-series charts use the accent (indigo-500), which sits in the same lightness band. */
export const ACCENT_CHART = "#615fff";
