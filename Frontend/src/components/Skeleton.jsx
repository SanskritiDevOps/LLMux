/** A grey placeholder shaped like the content it stands for. No shimmer with reduced motion. */
export function Skeleton({ className = "", ...props }) {
  return (
    <div
      aria-hidden="true"
      {...props}
      className={`animate-pulse rounded-md bg-slate-800 motion-reduce:animate-none ${className}`}
    />
  );
}
