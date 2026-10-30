import { Skeleton } from "./Skeleton.jsx";

/**
 * The one table style. Wide tables scroll sideways inside their card, never the page.
 * Rows are in the order given: the server decides it (logs newest first, keys newest
 * first), because sorting one loaded page would misrepresent the rest.
 *
 * @param {{
 *   columns: { key: string, header: string, render?: (row) => React.ReactNode,
 *              align?: "right", className?: string }[],
 *   rows: object[], rowKey: (row) => string, loading?: boolean, skeletonRows?: number,
 *   onRowClick?: (row) => void, rowLabel?: (row) => string, rowClassName?: (row) => string,
 *   caption: string,
 * }} props
 */
export function DataTable({
  columns,
  rows,
  rowKey,
  loading = false,
  skeletonRows = 8,
  onRowClick,
  rowLabel,
  rowClassName,
  caption,
}) {
  const cell = (column) =>
    `whitespace-nowrap px-3 py-2 ${column.align === "right" ? "text-right tabular-nums" : ""} ${column.className ?? ""}`;

  return (
    <div className="overflow-x-auto rounded-lg border border-slate-800 bg-slate-900">
      <table className="min-w-full text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="border-b border-slate-800 text-xs text-slate-400">
          <tr>
            {columns.map((column) => (
              <th key={column.key} scope="col" className={`${cell(column)} font-medium`}>
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800">
          {loading
            ? Array.from({ length: skeletonRows }, (_, i) => (
                <tr key={i}>
                  {columns.map((column) => (
                    <td key={column.key} className={cell(column)}>
                      <Skeleton className="h-4 w-16" />
                    </td>
                  ))}
                </tr>
              ))
            : rows.map((row) => (
                <tr
                  key={rowKey(row)}
                  {...(onRowClick && {
                    tabIndex: 0,
                    "aria-label": rowLabel?.(row),
                    onClick: () => onRowClick(row),
                    onKeyDown: (event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onRowClick(row);
                      }
                    },
                  })}
                  className={`${onRowClick ? "cursor-pointer transition-colors duration-150 hover:bg-slate-800/60 focus-visible:bg-slate-800/60 focus-visible:outline-none" : ""} ${rowClassName?.(row) ?? ""}`}
                >
                  {columns.map((column) => (
                    <td key={column.key} className={cell(column)}>
                      {column.render ? column.render(row) : row[column.key]}
                    </td>
                  ))}
                </tr>
              ))}
        </tbody>
      </table>
    </div>
  );
}
