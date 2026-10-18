import { getScanFiling, type ScanRow } from "@/lib/scan-queries";
import { ACTION_LABEL, isBuy, isSell, memberLabel, range, shortDate } from "@/lib/format";
import { Card, Empty, SectionTitle, StatTile } from "../../charts";
import { PartyBadge, StatusBadge } from "../../ui";

export const dynamic = "force-dynamic";

const LETTERS = "ABCDEFGHIJK";
const BRACKET: Record<string, string> = {
  A: "$1k–$15k",
  B: "$15k–$50k",
  C: "$50k–$100k",
  D: "$100k–$250k",
  E: "$250k–$500k",
  F: "$500k–$1M",
  G: "$1M–$5M",
  H: "$5M–$25M",
  I: "$25M–$50M",
  J: "over $50M",
  K: "spouse/DC over $1M (no bracket)",
};
const STATUS_LABEL: Record<string, string> = {
  read: "read",
  unknown_amount: "amount unknown",
  unknown_type: "type unknown",
  unknown: "both unknown",
  type_disputed: "type disputed",
  page_refused: "page refused",
};

/**
 * One scanned filing, page by page: the captured image with the grid
 * reader's decisions drawn over it, and the rows it read beside it. The
 * overlay is drawn from `scan_rows` in the image's own pixels. Direction
 * uses the site's blue/red diverging pair and is always spelled out in the
 * table; unknown rows are outlined dashed in the neutral axis colour and
 * labelled.
 */
export default async function ScanDetailPage({ params }: { params: Promise<{ docId: string }> }) {
  const { docId } = await params;
  let data;
  try {
    data = await getScanFiling(decodeURIComponent(docId));
  } catch (err) {
    return <Empty>{(err as Error).message}</Empty>;
  }
  if (!data) {
    return (
      <Empty>
        No scanned filing {docId}.{" "}
        <a href="/scans" className="underline underline-offset-2 hover:text-primary">
          All scans
        </a>
      </Empty>
    );
  }
  const { filing, pages, rows } = data;
  const byPage = new Map<number, ScanRow[]>();
  for (const r of rows) byPage.set(r.page_no, [...(byPage.get(r.page_no) ?? []), r]);
  const unknown = rows.filter((r) => r.status !== "read").length;
  const linked = rows.filter((r) => r.transaction_id != null).length;
  const failedPages = pages.filter((p) => p.error).length;

  return (
    <div className="space-y-8">
      <div>
        <a href="/scans" className="text-xs text-muted-foreground hover:text-primary">
          ← all scans
        </a>
        <h1 className="mt-2 font-mono text-3xl font-semibold tracking-tight">{filing.doc_id}</h1>
        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
          <PartyBadge party={filing.party} />
          <a
            href={`/politicians?m=${encodeURIComponent(filing.member_name)}`}
            className="font-medium text-foreground hover:text-primary"
          >
            {memberLabel(filing.member_name, null, filing.state, filing.district, "house")}
          </a>
          <span>· filed {shortDate(filing.filing_date)}</span>
          <StatusBadge value={filing.status} />
          <span className="font-mono text-[11px]">{filing.parse_method}</span>
          {filing.last_error ? <span className="font-mono text-[11px]">{filing.last_error}</span> : null}
          <a
            href={filing.pdf_url}
            target="_blank"
            rel="noreferrer"
            className="underline-offset-2 hover:text-primary hover:underline"
          >
            · Clerk PDF
          </a>
        </p>
      </div>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile
          label="Pages"
          value={String(pages.length)}
          hint={failedPages ? `${failedPages} yielded no rows` : "all decomposed and joined"}
        />
        <StatTile label="Rows read" value={String(rows.length)} hint="transaction rows the grid found" />
        <StatTile label="Unknown" value={String(unknown)} hint="amount or type not called" />
        <StatTile
          label="Linked"
          value={String(linked)}
          hint={filing.transactions ? `of ${filing.transactions} transactions` : "no transcription yet"}
        />
      </section>

      {pages.length === 0 ? (
        <Empty>
          Not captured yet. Run <code className="font-mono">python -m whale capture-scans</code>.
        </Empty>
      ) : null}

      {pages.map((page) => {
        const pageRows = byPage.get(page.page_no) ?? [];
        return (
          <section key={page.page_no}>
            <SectionTitle
              right={
                <span className="text-[11px] text-muted-foreground">
                  {page.width}×{page.height} px at {page.dpi} dpi
                  {page.rotation ? ` · turned ${page.rotation}°` : ""}
                </span>
              }
            >
              Page {page.page_no} · {pageRows.length} row{pageRows.length === 1 ? "" : "s"}
            </SectionTitle>
            {page.error ? (
              <p className="mb-2 text-xs text-amber-600 dark:text-amber-400">
                This page yielded no rows: <span className="font-mono">{page.error}</span>
              </p>
            ) : null}
            <div className="grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
              <Card className="p-2">
                <div className="relative w-full">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`/api/scan-page/${filing.id}/${page.page_no}`}
                    width={page.width}
                    height={page.height}
                    alt={`Page ${page.page_no} of filing ${filing.doc_id}`}
                    className="block h-auto w-full rounded-lg bg-white"
                  />
                  <Overlay width={page.width} height={page.height} rows={pageRows} />
                </div>
              </Card>
              <Card className="overflow-x-auto p-0">
                {pageRows.length ? (
                  <table className="w-full text-[12px]">
                    <thead>
                      <tr className="border-b border-border text-left text-[10px] uppercase tracking-[0.06em] text-muted-foreground">
                        <th className="px-3 py-2 font-medium">#</th>
                        <th className="px-3 py-2 font-medium">Amount</th>
                        <th className="px-3 py-2 text-right font-medium">margin</th>
                        <th className="px-3 py-2 font-medium">Type</th>
                        <th className="px-3 py-2 text-right font-medium">margin</th>
                        <th className="px-3 py-2 font-medium">Transaction</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pageRows.map((r) => (
                        <tr
                          key={r.id}
                          className={`border-b border-border/50 last:border-0 ${
                            r.status !== "read" ? "bg-amber-500/5" : ""
                          }`}
                        >
                          <td className="tabular px-3 py-1.5 text-muted-foreground">{r.row_index + 1}</td>
                          <td className="px-3 py-1.5">
                            {r.amount_letter ? (
                              <span>
                                <span className="font-mono font-semibold">{r.amount_letter}</span>{" "}
                                <span className="text-muted-foreground">{BRACKET[r.amount_letter]}</span>
                              </span>
                            ) : (
                              <span className="text-amber-600 dark:text-amber-400">
                                unknown
                                {r.amount_marks.length > 1
                                  ? ` (${r.amount_marks.map((i) => LETTERS[i]).join(", ")} ticked)`
                                  : " (no tick)"}
                              </span>
                            )}
                          </td>
                          <td className="tabular px-3 py-1.5 text-right text-muted-foreground">
                            {r.amount_margin?.toFixed(2) ?? "—"}
                          </td>
                          <td className="px-3 py-1.5">
                            {r.action ? (
                              <span
                                className={
                                  isBuy(r.action)
                                    ? "text-[#1c5cab] dark:text-[#86b6ef]"
                                    : isSell(r.action)
                                      ? "text-[#a32c2c] dark:text-[#e89f9f]"
                                      : ""
                                }
                              >
                                {ACTION_LABEL[r.action] ?? r.action}
                              </span>
                            ) : (
                              <span className="text-amber-600 dark:text-amber-400">
                                unknown{r.type_marks.length > 1 ? " (several ticked)" : " (no tick)"}
                              </span>
                            )}
                          </td>
                          <td className="tabular px-3 py-1.5 text-right text-muted-foreground">
                            {r.type_margin?.toFixed(2) ?? "—"}
                          </td>
                          <td className="px-3 py-1.5">
                            {r.transaction_id != null ? (
                              <span>
                                <span className="text-foreground">{r.asset_name}</span>
                                <span className="text-muted-foreground">
                                  {" "}· {shortDate(r.tx_date)} · {range(r.amount_min_cents, r.amount_max_cents)}
                                </span>
                                {r.status === "type_disputed" ? (
                                  <span className="text-amber-600 dark:text-amber-400"> · type disputed, grid kept</span>
                                ) : null}
                              </span>
                            ) : (
                              <span className="text-muted-foreground">
                                {STATUS_LABEL[r.status]} · not transcribed
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p className="p-4 text-xs text-muted-foreground">
                    {page.error ? "No rows: the page yielded none." : "No transaction rows on this page."}
                  </p>
                )}
              </Card>
            </div>
          </section>
        );
      })}

      <p className="text-[11px] text-muted-foreground">
        Overlay: each row the reader counted as a transaction is boxed; its amount and type
        column edges are drawn; the cell it read as ticked is filled — blue for a buy, red for a
        sell, grey for an exchange, and the amount cell in the sequential colour. A row with
        no tick or more than one is outlined dashed and listed as unknown; it is stored as
        unknown, never guessed. The margin is how far the strongest cell stood above the
        row&rsquo;s median ink; boxed forms need 0.15.
      </p>
    </div>
  );
}

function Overlay({ width, height, rows }: { width: number; height: number; rows: ScanRow[] }) {
  if (!rows.length) return null;
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="pointer-events-none absolute inset-0 h-full w-full"
      aria-hidden
    >
      {rows.map((r) => {
        const unknown = r.status !== "read";
        const left = Math.min(r.type_cols[0] ?? r.amount_cols[0], r.amount_cols[0]);
        const right = r.amount_cols[r.amount_cols.length - 1];
        const typeFill = r.action
          ? isBuy(r.action)
            ? "var(--viz-buy)"
            : isSell(r.action)
              ? "var(--viz-sell)"
              : "var(--viz-axis)"
          : "var(--viz-axis)";
        return (
          <g key={r.id}>
            <rect
              x={left - 4}
              y={r.y0}
              width={right - left + 8}
              height={r.y1 - r.y0}
              fill="none"
              stroke="var(--viz-axis)"
              strokeWidth={unknown ? 2 : 1}
              strokeDasharray={unknown ? "6 4" : undefined}
            />
            {r.amount_cols.map((x, i) => (
              <line
                key={`a${i}`}
                x1={x}
                y1={r.y0}
                x2={x}
                y2={r.y1}
                stroke="var(--viz-seq)"
                strokeWidth={0.75}
                strokeOpacity={0.6}
              />
            ))}
            {r.type_cols.map((x, i) => (
              <line
                key={`t${i}`}
                x1={x}
                y1={r.y0}
                x2={x}
                y2={r.y1}
                stroke="var(--viz-axis)"
                strokeWidth={0.75}
                strokeOpacity={0.6}
              />
            ))}
            {r.amount_marks.map((i) => (
              <rect
                key={`am${i}`}
                x={r.amount_cols[i]}
                y={r.y0}
                width={r.amount_cols[i + 1] - r.amount_cols[i]}
                height={r.y1 - r.y0}
                fill="var(--viz-seq)"
                fillOpacity={unknown ? 0.18 : 0.3}
              />
            ))}
            {r.type_marks.map((i) => (
              <rect
                key={`tm${i}`}
                x={r.type_cols[i]}
                y={r.y0}
                width={r.type_cols[i + 1] - r.type_cols[i]}
                height={r.y1 - r.y0}
                fill={typeFill}
                fillOpacity={unknown ? 0.18 : 0.3}
              />
            ))}
            <text
              x={right + 8}
              y={r.y0 + (r.y1 - r.y0) / 2 + 4}
              fontSize={11}
              fontFamily="ui-monospace, monospace"
              fill={unknown ? "var(--viz-axis)" : "var(--viz-seq)"}
            >
              {r.row_index + 1}
              {unknown ? " ?" : ""}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
