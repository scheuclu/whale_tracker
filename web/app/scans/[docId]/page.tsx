import Link from "next/link";
import { getScanFiling, parsePageNo, type ScanPage, type ScanRow } from "@/lib/scan-queries";
import { ACTION_LABEL, OWNER_LABEL, isBuy, isSell, memberLabel, range, shortDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Card, Empty, SectionTitle, StatTile } from "../../charts";
import { PartyBadge, StatusBadge, ResponsiveTable } from "../../ui";

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
/** A status the pipeline adds later shows as its own words, never as a blank. */
function statusLabel(status: string): string {
  return STATUS_LABEL[status] ?? status.replace(/_/g, " ");
}

/**
 * One scanned filing, one page at a time: the captured image with the grid
 * reader's decisions drawn over it, and the rows it read beside it. The
 * overlay is drawn from `scan_rows` in the image's own pixels. Direction
 * uses the site's blue/red diverging pair and is always spelled out in the
 * table; unknown rows are outlined dashed in the neutral axis colour and
 * labelled. A transcribed row shows what the model read beside what the
 * grid decided, and says so where the two disagreed.
 */
export default async function ScanDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ docId: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const [{ docId }, sp] = await Promise.all([params, searchParams]);
  const pageNo = parsePageNo(sp.page);
  let data;
  try {
    data = await getScanFiling(decodeURIComponent(docId), pageNo);
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
  const base = `/scans/${encodeURIComponent(filing.doc_id)}`;
  const index = pages.findIndex((p) => p.page_no === pageNo);
  const page = index >= 0 ? pages[index] : null;
  const prev = index > 0 ? pages[index - 1] : null;
  const next = index >= 0 && index < pages.length - 1 ? pages[index + 1] : null;
  const failedPages = pages.filter((p) => p.error).length;
  const disputed = rows.filter((r) => r.type_disputed || r.amount_disputed).length;

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
          {filing.last_error ? <span className="break-all font-mono text-[11px]">{filing.last_error}</span> : null}
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
        <StatTile label="Rows read" value={String(filing.rows)} hint="transaction rows the grid found" />
        <StatTile label="Unknown" value={String(filing.unknown_rows)} hint="amount or type not called" />
        <StatTile
          label="Linked"
          value={String(filing.linked)}
          hint={filing.transactions ? `of ${filing.transactions} transactions` : "no transcription yet"}
        />
      </section>

      {pages.length === 0 ? (
        <Empty>
          Not captured yet. Run <code className="font-mono">python -m whale capture-scans</code>.
        </Empty>
      ) : (
        <Pager base={base} pages={pages} current={pageNo} prev={prev} next={next} />
      )}

      {pages.length > 0 && !page ? (
        <Empty>
          No page {pageNo} — this filing has {pages.length} page{pages.length === 1 ? "" : "s"}.{" "}
          <Link href={base} className="underline underline-offset-2 hover:text-primary">
            Page 1
          </Link>
        </Empty>
      ) : null}

      {page ? (
        <section>
          <SectionTitle
            right={
              <span className="text-[11px] text-muted-foreground">
                {page.width}×{page.height} px at {page.dpi} dpi
                {page.rotation ? ` · turned ${page.rotation}°` : ""}
              </span>
            }
          >
            Page {page.page_no} of {pages.length} · {rows.length} row{rows.length === 1 ? "" : "s"}
            {page.unknown_rows ? ` · ${page.unknown_rows} unknown` : ""}
            {disputed ? ` · ${disputed} disputed` : ""}
          </SectionTitle>
          {page.error ? (
            <p className="mb-2 text-xs text-amber-600 dark:text-amber-400">
              This page yielded no rows: <span className="break-all font-mono">{page.error}</span>
            </p>
          ) : null}
          {/* An even split: the page is landscape, and the transcription column
              now carries the asset name, owner and any disagreement note. */}
          <div className="grid grid-cols-[minmax(0,1fr)] gap-4 xl:grid-cols-2">
            <Card className="p-2">
              <div className="relative w-full">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/api/scan-page/${filing.id}/${page.page_no}`}
                  width={page.width}
                  height={page.height}
                  loading="lazy"
                  decoding="async"
                  alt={`Page ${page.page_no} of filing ${filing.doc_id}`}
                  className="block h-auto w-full rounded-lg bg-white"
                />
                <Overlay width={page.width} height={page.height} rows={rows} />
              </div>
            </Card>
            <ResponsiveTable wrap>
              {rows.length ? (
                <table className="w-full text-[12px]">
                  <thead>
                    <tr className="border-b border-border text-left text-[12px] font-medium text-muted-foreground">
                      <th className="px-3 py-2 font-medium">#</th>
                      <th className="px-3 py-2 font-medium">Amount</th>
                      <th className="px-3 py-2 text-right font-medium">margin</th>
                      <th className="px-3 py-2 font-medium">Type</th>
                      <th className="px-3 py-2 text-right font-medium">margin</th>
                      <th className="px-3 py-2 font-medium">Transcription</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <RowLine key={r.id} r={r} />
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="p-4 text-xs text-muted-foreground">
                  {page.error ? "No rows: the page yielded none." : "No transaction rows on this page."}
                </p>
              )}
            </ResponsiveTable>
          </div>
        </section>
      ) : null}

      <div className="space-y-2 text-[11px] text-muted-foreground">
        <p>
          Overlay: each row the reader counted as a transaction is boxed; its amount and type
          column edges are drawn; the cell it read as ticked is filled — blue for a buy, red for a
          sell, grey for an exchange, and the amount cell in the sequential colour. A row with
          no tick or more than one is outlined dashed and listed as unknown; it is stored as
          unknown, never guessed. The margin is how far the strongest cell stood above the
          row&rsquo;s median ink; boxed forms need 0.15. The row number links to the row, so a
          URL with <code className="font-mono">?page=N#row-M</code> lands on it.
        </p>
        <p>
          Transcription: the asset, date, owner and bracket are the stored transaction, which
          took its amount and type from the grid. Where the model read a different letter or
          type the row says so — the grid was kept, and a filing with more than one type
          disagreement is refused rather than joined. A row&rsquo;s status is the reader&rsquo;s own.
        </p>
        <p>
          Re-capturing after a reader change: <code className="font-mono">capture-scans</code>{" "}
          skips a filing that already has pages, so a changed reader does not refresh this view by
          itself. Delete this filing&rsquo;s pages —{" "}
          <code className="font-mono">
            sqlite3 data/trades.sqlite3 &quot;DELETE FROM scan_pages WHERE filing_id = {filing.id}&quot;
          </code>{" "}
          — and run <code className="font-mono">python -m whale capture-scans</code> again: pages
          and rows are stored afresh and re-linked to the transactions by order (no links, not
          wrong ones, if the counts no longer match). The transactions are untouched. Page images
          are cached for a week, so a hard reload may be needed to see the new capture.
        </p>
      </div>
    </div>
  );
}

/**
 * Prev/next plus a strip of every page. A page with unknown rows is marked
 * "?" and one the reader could not decompose "!", in text as well as
 * colour; the title carries the counts.
 */
function Pager({
  base,
  pages,
  current,
  prev,
  next,
}: {
  base: string;
  pages: ScanPage[];
  current: number;
  prev: ScanPage | null;
  next: ScanPage | null;
}) {
  const navCls = "rounded-md border border-border px-2.5 py-1 text-xs hover:border-primary/40 hover:bg-accent";
  const offCls = "rounded-md border border-transparent px-2.5 py-1 text-xs text-muted-foreground";
  return (
    <nav aria-label="Pages" className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        {prev ? (
          <Link href={`${base}?page=${prev.page_no}`} className={navCls} rel="prev">
            ← Page {prev.page_no}
          </Link>
        ) : (
          <span className={offCls}>← first page</span>
        )}
        <span className="tabular text-xs text-muted-foreground">
          Page {current} of {pages.length}
        </span>
        {next ? (
          <Link href={`${base}?page=${next.page_no}`} className={navCls} rel="next">
            Page {next.page_no} →
          </Link>
        ) : (
          <span className={offCls}>last page →</span>
        )}
      </div>
      <ol className="flex flex-wrap gap-1">
        {pages.map((p) => {
          const isCurrent = p.page_no === current;
          const title = p.error
            ? `Page ${p.page_no}: the reader could not decompose it`
            : `Page ${p.page_no}: ${p.rows} row${p.rows === 1 ? "" : "s"}, ${p.unknown_rows} unknown, ${p.linked} linked`;
          return (
            <li key={p.page_no}>
              <Link
                href={`${base}?page=${p.page_no}`}
                aria-current={isCurrent ? "page" : undefined}
                title={title}
                className={cn(
                  "tabular inline-block min-w-8 rounded-md border px-1.5 py-0.5 text-center text-[11px]",
                  isCurrent
                    ? "border-foreground bg-foreground font-semibold text-background"
                    : "border-border hover:border-primary/40 hover:bg-accent",
                  !isCurrent && p.error ? "text-red-600 dark:text-red-400" : "",
                  !isCurrent && !p.error && p.unknown_rows ? "text-amber-600 dark:text-amber-400" : ""
                )}
              >
                {p.page_no}
                {p.error ? "!" : p.unknown_rows ? "?" : ""}
              </Link>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function RowLine({ r }: { r: ScanRow }) {
  const n = r.row_index + 1;
  const flagged = r.status !== "read" || r.type_disputed;
  return (
    <tr
      id={`row-${n}`}
      className={cn(
        // scroll-mt clears the sticky site header (~117px) when the row is the URL's anchor.
        "scroll-mt-32 border-b border-border/50 last:border-0 target:bg-primary/10",
        flagged ? "bg-amber-500/5" : ""
      )}
    >
      <td className="tabular px-3 py-1.5 text-muted-foreground">
        <a href={`#row-${n}`} className="hover:text-primary">
          {n}
        </a>
      </td>
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
          <div className="space-y-0.5">
            <div className="text-foreground">{r.asset_name}</div>
            <div className="text-muted-foreground">
              {shortDate(r.tx_date)}
              {r.owner ? ` · ${OWNER_LABEL[r.owner] ?? r.owner}` : ""}
              {" · "}
              <span className="tabular">{range(r.amount_min_cents, r.amount_max_cents)}</span>
            </div>
            {r.type_disputed ? (
              <div className="text-amber-600 dark:text-amber-400">
                type disputed: model read {ACTION_LABEL[r.model_action ?? ""] ?? r.model_action}; grid&rsquo;s{" "}
                {ACTION_LABEL[r.action ?? ""] ?? r.action} kept
              </div>
            ) : null}
            {r.amount_disputed ? (
              <div className="text-amber-600 dark:text-amber-400">
                amount: model read {r.model_amount_letter}; grid&rsquo;s {r.amount_letter} kept
              </div>
            ) : null}
            {r.status !== "read" ? (
              <div className="text-amber-600 dark:text-amber-400">{statusLabel(r.status)}</div>
            ) : null}
          </div>
        ) : (
          <span className="text-muted-foreground">{statusLabel(r.status)} · not transcribed</span>
        )}
      </td>
    </tr>
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
