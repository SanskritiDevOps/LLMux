import { providerStyle } from "../lib/providers.js";

/** A provider's name with its colour dot. The name is always shown, never colour alone. */
export function ProviderBadge({ provider }) {
  if (!provider) return <span className="text-slate-500">—</span>;
  const style = providerStyle(provider);
  return (
    <span className={`inline-flex items-center gap-1.5 text-sm ${style.text}`}>
      <span aria-hidden="true" className={`size-2 rounded-full ${style.dot}`} />
      {style.label}
    </span>
  );
}
