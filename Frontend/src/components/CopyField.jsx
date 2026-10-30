import { useEffect, useState } from "react";
import { Button } from "./Button.jsx";

/** A monospace value with a copy button that confirms for 2 seconds. */
export function CopyField({ value, label = "Value" }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setFailed(false);
      setCopied(true);
    } catch {
      // Clipboard access can be refused (permissions, insecure origin): the value is
      // selectable, so it can still be copied by hand.
      setFailed(true);
    }
  };

  return (
    <div>
      <div className="flex items-stretch gap-2">
        <code
          aria-label={label}
          className="min-w-0 flex-1 rounded-md border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-sm break-all text-slate-100 select-all"
        >
          {value}
        </code>
        <Button variant="secondary" onClick={copy} aria-live="polite">
          {copied ? "Copied ✓" : "Copy"}
        </Button>
      </div>
      {failed && (
        <p className="mt-1 text-xs text-amber-300">
          Couldn't copy automatically. Select the key and copy it by hand.
        </p>
      )}
    </div>
  );
}
