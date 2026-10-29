/** The centred card around the login and register forms. */
export function AuthLayout({ title, children, footer }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 p-4 text-slate-100">
      <div className="w-full max-w-sm">
        <p className="mb-6 text-center font-mono text-xl font-semibold tracking-tight">LLMux</p>
        <div className="rounded-lg border border-slate-800 bg-slate-900 p-6">
          <h1 className="mb-6 text-lg font-medium">{title}</h1>
          {children}
        </div>
        <p className="mt-4 text-center text-sm text-slate-400">{footer}</p>
      </div>
    </main>
  );
}
