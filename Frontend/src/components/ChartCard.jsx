import { ErrorNotice } from "./ErrorNotice.jsx";
import { Skeleton } from "./Skeleton.jsx";

/**
 * A card with a title and a chart, plus its loading, empty and error states. Every chart
 * also renders its data as a table for screen readers (`table`: { columns, rows }).
 */
export function ChartCard({
  title,
  query,
  isEmpty,
  emptyText = "No data in this range",
  table,
  height = 240,
  children,
}) {
  return (
    <section className="rounded-lg border border-slate-800 bg-slate-900 p-4">
      <h2 className="mb-4 text-lg font-medium text-slate-100">{title}</h2>
      {query.isPending ? (
        <Skeleton className="w-full" style={{ height }} />
      ) : query.isError ? (
        <ErrorNotice error={query.error} title="Couldn't load this chart" />
      ) : isEmpty ? (
        <div
          className="flex items-center justify-center border-b border-slate-800 text-sm text-slate-400"
          style={{ height }}
        >
          {emptyText}
        </div>
      ) : (
        <>
          <div aria-hidden="true" style={{ height }}>
            {children}
          </div>
          {table && (
            <table className="sr-only">
              <caption>{title}</caption>
              <thead>
                <tr>
                  {table.columns.map((column) => (
                    <th key={column} scope="col">
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((row, i) => (
                  <tr key={i}>
                    {row.map((cell, j) => (
                      <td key={j}>{cell}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
}
