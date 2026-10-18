/**
 * The home feed as a timeline: trades grouped under sticky day headers, and
 * within a day, consecutive trades from one filing drawn as one block so a
 * 30-trade filing reads as one member with 30 lines rather than 30 repeats
 * of the name.
 *
 * Days are keyed on the **trade date**, because that is what the feed is
 * ordered by (`ORDER BY t.tx_date DESC, t.id DESC` in getTransactions):
 * grouping the same rows on filing date would scatter one filing day across
 * many headers. The filing date and the disclosure delay stay on every
 * block/row.
 *
 * Layout (one grid, see `.feed-row` in globals.css):
 *   ≥1024px   member column | one line per trade
 *   ≥640px    member line above | one line per trade
 *   <640px    member line above | two lines per trade
 * The member cell leaves room at its start for a ~24px avatar.
 */

import type { TransactionRow } from "@/lib/queries";
import {
  filedBeforeTrade,
  groupFeed,
  monthDay,
  todayIso,
  type DayGroup,
  type FilingBlock,
} from "@/lib/feed";
import { ASSET_TYPE_LABEL, memberHref, memberLabel } from "@/lib/format";
import { cn } from "@/lib/utils";
import { BracketAmount, BracketLegend } from "./bracket-glyph";
import { StickyOffset } from "./sticky-offset";
import { ActionBadge, DelayTag, OptionBadge, OwnerTag, PartyBadge, ScanTag, TickerChip } from "./ui";

/* ------------------------------------------------------------- header */

type Direction = "buy" | "sell" | undefined;

/**
 * All / Buys / Sells as a segmented control. `hrefFor` builds each target
 * so a page with more filters can keep them (the default is the bare feed).
 */
export function DirectionFilter({
  current,
  hrefFor = (k) => (k ? `/?action=${k}` : "/"),
}: {
  current: string | undefined;
  hrefFor?: (k: Direction) => string;
}) {
  const options: { k: Direction; label: string; dot?: string }[] = [
    { k: undefined, label: "All" },
    { k: "buy", label: "Buys", dot: "bg-[var(--viz-buy)]" },
    { k: "sell", label: "Sells", dot: "bg-[var(--viz-sell)]" },
  ];
  const active = current === "buy" || current === "sell" ? current : undefined;
  return (
    <nav aria-label="Trade direction" className="inline-flex rounded-lg border border-border bg-muted p-0.5 text-xs">
      {options.map((o) => {
        const on = active === o.k;
        return (
          <a
            key={o.label}
            href={hrefFor(o.k)}
            aria-current={on ? "page" : undefined}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring",
              on
                ? "bg-[var(--card-solid)] text-foreground shadow-sm ring-1 ring-border"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {o.dot ? <span className={cn("size-1.5 rounded-full", o.dot)} aria-hidden /> : null}
            {o.label}
          </a>
        );
      })}
    </nav>
  );
}

/* --------------------------------------------------------------- list */

export function FeedList({
  rows,
  toolbar,
  summary,
  empty = "No trades match this filter.",
}: {
  rows: TransactionRow[];
  /** Controls at the left of the list header (the direction filter). */
  toolbar?: React.ReactNode;
  /** The count/total line beside the controls (feed-controls' ShownLine). */
  summary?: React.ReactNode;
  empty?: React.ReactNode;
}) {
  const today = todayIso();
  const days = groupFeed(rows, today);
  return (
    <div className="glass rounded-2xl border border-border bg-card">
      <StickyOffset />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-3 py-3 sm:px-4">
        {toolbar}
        {/* ShownLine brings a bottom margin for a standalone line; in the bar it has none. */}
        <div className="order-last min-w-0 basis-full sm:order-none sm:basis-0 sm:flex-1 [&>p]:mb-0">
          {rows.length ? summary : null}
        </div>
        <BracketLegend className="hidden md:inline-flex" />
      </div>
      {rows.length ? (
        days.map((day, i) => <DaySection key={`${day.key}-${i}`} day={day} today={today} index={i} />)
      ) : (
        <div className="px-4 py-10 text-center text-sm text-muted-foreground">{empty}</div>
      )}
    </div>
  );
}

function DaySection({ day, today, index }: { day: DayGroup<TransactionRow>; today: string; index: number }) {
  const id = `feed-day-${index}`;
  return (
    <section aria-labelledby={id} className="feed-day relative last:rounded-b-2xl">
      <h3
        id={id}
        className={cn(
          "feed-day-head sticky z-20 flex h-8 items-center gap-2 border-b border-border px-3 text-xs sm:px-4",
          index > 0 && "border-t"
        )}
      >
        <span className="font-semibold tracking-tight text-foreground">{day.label}</span>
        {day.date ? <span className="text-muted-foreground">{day.date}</span> : null}
        {day.future ? (
          <span
            className="rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-px text-[10px] font-medium text-amber-700 dark:text-amber-300"
            title="This trade date is later than today: the filing's own date, reproduced as filed rather than corrected"
          >
            future date as filed
          </span>
        ) : null}
        {day.key === null ? null : (
          <span className="hidden text-[11px] text-muted-foreground/80 sm:inline">traded</span>
        )}
        <span className="flex-1" />
        <span className="tabular text-[11px] text-muted-foreground">
          {day.trades} {day.trades === 1 ? "trade" : "trades"}
          <span aria-hidden> · </span>
          {day.filings} {day.filings === 1 ? "filing" : "filings"}
        </span>
      </h3>
      <ol className="divide-y divide-border">
        {day.blocks.map((b, i) => (
          <FilingBlockView key={`${b.key}-${i}`} block={b} today={today} />
        ))}
      </ol>
    </section>
  );
}

function FilingBlockView({ block, today }: { block: FilingBlock<TransactionRow>; today: string }) {
  const r0 = block.rows[0];
  const n = block.rows.length;
  const label = memberLabel(r0.member_name, null, r0.state, r0.district, r0.chamber);
  const filed = r0.filing_date ? monthDay(r0.filing_date, today) : null;
  return (
    <li className="feed-block lg:grid lg:grid-cols-[15rem_minmax(0,1fr)]">
      <div className="px-3 pt-2 sm:px-4 lg:py-2 lg:pr-2">
        <div className="feed-member flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 lg:flex-col lg:flex-nowrap lg:items-start">
          {/* An avatar (~24px) slots in at the start of this row. */}
          <div className="flex min-w-0 max-w-full items-center gap-1.5 lg:w-full lg:items-start">
            <span className="flex shrink-0 lg:mt-px">
              <PartyBadge party={r0.party} />
            </span>
            <a
              href={memberHref(r0.member_name, r0.bioguide_id)}
              className="min-w-0 truncate text-[13px] font-medium hover:text-primary focus-visible:text-primary lg:line-clamp-2 lg:whitespace-normal lg:leading-snug"
              title={label}
            >
              {label}
            </a>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground lg:ml-0">
            {n > 1 ? (
              <span className="tabular">
                {n} trades
                <span aria-hidden> · </span>
              </span>
            ) : null}
            {filed ? <span className="tabular">filed {filed}</span> : null}
            <a
              href={r0.pdf_url}
              target="_blank"
              rel="noreferrer"
              className="underline decoration-border underline-offset-2 hover:text-primary hover:decoration-primary"
            >
              filing<span aria-hidden>&nbsp;↗</span>
              <span className="sr-only"> (opens the original filing)</span>
            </a>
          </div>
        </div>
      </div>
      <ul className={cn("px-1.5 pb-1.5 pt-1 sm:px-2 lg:py-1.5 lg:pl-0", n > 1 && "feed-run")}>
        {block.rows.map((r) => (
          <TradeRow key={r.id} r={r} />
        ))}
      </ul>
    </li>
  );
}

/**
 * Short names for the asset-type label shown where a row has no ticker, so
 * "Government / agency debt" fits the ticker column; the full label stays
 * in the title. Unknown codes fall back to the full label.
 */
const SHORT_TYPE: Record<string, string> = {
  GS: "Gov. debt",
  CS: "Corp. bond",
  MF: "Mutual fund",
  HN: "Fund",
  PS: "Private",
  OL: "Business",
  AB: "ABS",
  VA: "Annuity",
  BA: "Bank acct.",
  SA: "SAR",
};

function TickerCell({ ticker, type }: { ticker: string | null; type: string | null }) {
  if (ticker) return <TickerChip ticker={ticker} type={type} />;
  const full = type ? ASSET_TYPE_LABEL[type] ?? type : "no ticker";
  return (
    <span className="text-xs text-muted-foreground" title={full}>
      {type ? SHORT_TYPE[type] ?? full : full}
    </span>
  );
}

function Delay({ r }: { r: TransactionRow }) {
  if (!r.dates_inconsistent && filedBeforeTrade(r.tx_date, r.filing_date)) {
    return (
      <span
        className="text-[11px] text-amber-600 dark:text-amber-400"
        title="The filing is dated before the trade it reports — reproduced as filed"
      >
        date as filed
      </span>
    );
  }
  return <DelayTag days={r.delay_days} inconsistent={r.dates_inconsistent} />;
}

function TradeRow({ r }: { r: TransactionRow }) {
  return (
    <li className="feed-row rounded-lg px-1.5 py-1 transition-colors hover:bg-[var(--feed-hover)] focus-within:bg-[var(--feed-hover)] sm:px-2">
      <span className="[grid-area:act]">
        <ActionBadge action={r.action} />
      </span>
      <span className="min-w-0 truncate [grid-area:tick]">
        <TickerCell ticker={r.ticker} type={r.asset_type} />
      </span>
      <BracketAmount
        className="[grid-area:amt]"
        min={r.amount_min_cents}
        max={r.amount_max_cents}
        exact={r.amount_exact_cents}
        transcribed={r.transcribed}
      />
      <span className="flex min-w-0 items-center gap-1.5 text-[12.5px] [grid-area:asset]">
        <span className="min-w-0 truncate text-muted-foreground" title={r.asset_name}>
          {r.asset_name}
        </span>
        <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap empty:hidden">
          <OptionBadge kind={r.option_kind} strikeCents={r.strike_cents} expiry={r.expiry} />
          <OwnerTag owner={r.owner} />
          <ScanTag transcribed={r.transcribed} docId={r.doc_id} />
        </span>
        {/* Below 640px the delay ends the asset line; above, it has a column. */}
        <span className="ml-auto shrink-0 pl-1 sm:hidden">
          <Delay r={r} />
        </span>
      </span>
      <span className="hidden justify-self-end whitespace-nowrap text-right [grid-area:delay] sm:block">
        <Delay r={r} />
      </span>
    </li>
  );
}
