import { Link } from "react-router-dom";

export function NotFoundPage() {
  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <h1 className="text-2xl font-semibold text-slate-100">Page not found</h1>
      <p className="mt-2 text-sm text-slate-400">There's nothing at this address.</p>
      <Link
        to="/"
        className="mt-6 inline-block text-sm font-medium text-indigo-300 hover:text-indigo-200"
      >
        Go to the overview
      </Link>
    </div>
  );
}
