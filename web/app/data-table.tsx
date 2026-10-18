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
    <details className="mt-3 text-[12px] text-muted-foreground">
      <summary className="w-fit cursor-pointer select-none rounded-sm transition-colors duration-(--dur-fast) hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">Show as table</summary>
      <ResponsiveTable className="mt-2">
        <table className="w-full text-[13px]">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr className="border-b border-border text-[12px] font-medium">
              {columns.map((c) => (
                <th key={c} scope="col" className="px-3 py-1.5 text-right font-medium first:text-left">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-b border-border/60 last:border-0">
                {r.map((c, j) =>
                  j === 0 ? (
                    <th key={j} scope="row" className="px-3 py-1.5 text-left font-medium text-foreground">
                      {c}
                    </th>
                  ) : (
                    <td key={j} className="tabular px-3 py-1.5 text-right">
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
