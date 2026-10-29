const VARIANTS = {
  primary: "bg-indigo-500 text-white hover:bg-indigo-400 disabled:bg-indigo-500/50",
  secondary:
    "border border-slate-700 bg-slate-900 text-slate-100 hover:bg-slate-800 disabled:text-slate-500",
  danger: "bg-rose-500 text-white hover:bg-rose-400 disabled:bg-rose-500/50",
  ghost: "text-slate-300 hover:bg-slate-800 hover:text-slate-100 disabled:text-slate-500",
};

export function Spinner({ className = "" }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block size-4 animate-spin rounded-full border-2 border-current border-r-transparent motion-reduce:animate-none ${className}`}
    />
  );
}

/** A button that shows a spinner and can't be pressed again while `loading`. */
export function Button({
  variant = "primary",
  loading = false,
  disabled,
  className = "",
  children,
  type = "button",
  ...props
}) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={`inline-flex items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:cursor-not-allowed ${VARIANTS[variant]} ${className}`}
      {...props}
    >
      {loading && <Spinner />}
      {children}
    </button>
  );
}
