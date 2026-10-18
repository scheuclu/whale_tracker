import { ResponsiveTable } from "./ui";

/**
 * The table twin of a chart: every value, in text, reachable without a
 * pointer. Collapsed by default so the chart leads; the content is in the
 * DOM either way.
 */
export function DataTable({
  caption,
  columns,
  rows,
}: {
  caption: string;
  columns: string[];
  rows: (string | number)[][];
}) {
  return (
    <details className="mt-3 text-[11px] text-muted-foreground">
      <summary className="cursor-pointer select-none hover:text-foreground">Show as table</summary>
      <ResponsiveTable className="mt-2">
        <table className="w-full text-[12px]">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr className="border-b border-border text-[11px] uppercase tracking-[0.06em]">
              {columns.map((c) => (
                <th key={c} scope="col" className="px-2 py-1 text-right font-medium first:text-left">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-b border-border/50 last:border-0">
                {r.map((c, j) =>
                  j === 0 ? (
                    <th key={j} scope="row" className="px-2 py-1 text-left font-medium text-foreground">
                      {c}
                    </th>
                  ) : (
                    <td key={j} className="tabular px-2 py-1 text-right">
                      {c}
                    </td>
                  )
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </ResponsiveTable>
    </details>
  );
}
