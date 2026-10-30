import { useId } from "react";
import { PROVIDER_COLORS } from "../../lib/providers.js";
import { useKeyOptions } from "./useLogs.js";

const control =
  "rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500";

function Select({ label, value, onChange, children }) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-xs text-slate-400">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={control}
      >
        {children}
      </select>
    </div>
  );
}

/** One row of filters above the table. An empty value means "any". */
export function LogFilters({ filters, onChange }) {
  const keys = useKeyOptions();
  const modelId = useId();
  const set = (name) => (value) => onChange({ ...filters, [name]: value });

  return (
    <div className="mb-4 flex flex-wrap items-end gap-3" role="search" aria-label="Filter logs">
      <div>
        <label htmlFor={modelId} className="mb-1 block text-xs text-slate-400">
          Model
        </label>
        <input
          id={modelId}
          // Filters apply when the field loses focus or on Enter, not on every keystroke.
          defaultValue={filters.model}
          onBlur={(event) => set("model")(event.target.value.trim())}
          onKeyDown={(event) => {
            if (event.key === "Enter") set("model")(event.currentTarget.value.trim());
          }}
          placeholder="fast, smart, ollama:…"
          className={`${control} w-44 font-mono`}
        />
      </div>
      <Select label="Provider" value={filters.provider} onChange={set("provider")}>
        <option value="">Any</option>
        {Object.entries(PROVIDER_COLORS).map(([id, style]) => (
          <option key={id} value={id}>
            {style.label}
          </option>
        ))}
      </Select>
      <Select label="Status" value={filters.status} onChange={set("status")}>
        <option value="">Any</option>
        <option value="success">Success</option>
        <option value="error">Error</option>
        <option value="cancelled">Cancelled</option>
      </Select>
      <Select label="Cache" value={filters.cached} onChange={set("cached")}>
        <option value="">Any</option>
        <option value="true">Cache hits</option>
        <option value="false">Not cached</option>
      </Select>
      <Select label="Key" value={filters.keyId} onChange={set("keyId")}>
        <option value="">Any</option>
        {keys.data?.keys.map((key) => (
          <option key={key.id} value={key.id}>
            {key.name}
          </option>
        ))}
      </Select>
    </div>
  );
}
