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
 * Each day is an iOS inset-grouped list: a bold day header on the canvas
 * (sticky under the nav), then one white tile holding that day's filings,
 * separated by hairlines inset to the member's name.
 *
 * Layout (one grid, see `.feed-row` in globals.css):
 *   ≥1024px   member column | one line per trade
 *   ≥640px    member line above | one line per trade
 *   <640px    member line above | two lines per trade
 * The member cell starts with the member's 24px portrait (or monogram).
 */

import type { TransactionRow } from "@/lib/queries";
import { groupFeed, monthDay, todayIso, type DayGroup, type FilingBlock } from "@/lib/feed";
import { memberHref, memberLabel } from "@/lib/format";
import { cn } from "@/lib/utils";
import { MemberAvatar } from "./avatar";
import { BracketAmount, BracketLegend } from "./bracket-glyph";
import { StickyOffset } from "./sticky-offset";
import { AssetName, TickerCell, TradeDelay } from "./trade-row";
import { ActionBadge, OptionBadge, OwnerTag, PartyBadge, ScanTag, Segmented } from "./ui";

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
    { k: "buy", label: "Buys", dot: "var(--viz-buy)" },
    { k: "sell", label: "Sells", dot: "var(--viz-sell)" },
  ];
  const active = current === "buy" || current === "sell" ? current : undefined;
  // The shared iOS segmented control (ui.tsx); the dots repeat the words.
  return (
    <Segmented
      label="Trade direction"
      items={options.map((o) => ({ key: o.label, label: o.label, href: hrefFor(o.k), active: active === o.k, dot: o.dot }))}
    />
  );
}

/* --------------------------------------------------------------- list */

export function FeedList({
  rows,
  toolbar,
  summary,
  actions,
  empty = "No trades match this filter.",
}: {
  rows: TransactionRow[];
  /** Controls at the left of the list header (the direction filter). */
  toolbar?: React.ReactNode;
  /** The count/total line beside the controls (feed-controls' ShownLine). */
  summary?: React.ReactNode;
  /** Controls at the right end of the list header (the CSV export). */
  actions?: React.ReactNode;
  empty?: React.ReactNode;
}) {
  const today = todayIso();
  const days = groupFeed(rows, today);
  return (
    <div className="min-w-0">
      <StickyOffset />
      {/* The controls on the canvas: segmented direction, the Filter pill
          (its panel is positioned against this row), the count line, CSV. */}
      <div className="relative mb-2 flex flex-wrap items-center gap-x-2.5 gap-y-2.5">
        {toolbar}
        {/* ShownLine brings a bottom margin for a standalone line; in the bar it has none. */}
        <div className="order-last min-w-0 basis-full pl-1 pt-0.5 [&>p]:mb-0">
          {rows.length ? summary : null}
        </div>
        <div className="ml-auto flex items-center gap-4">
          <BracketLegend className="hidden md:inline-flex" />
          {actions}
        </div>
      </div>
      {rows.length ? (
        days.map((day, i) => <DaySection key={`${day.key}-${i}`} day={day} today={today} index={i} />)
      ) : (
        <div className="tile px-4 py-10 text-center text-[14px] text-muted-foreground">{empty}</div>
      )}
    </div>
  );
}

function DaySection({ day, today, index }: { day: DayGroup<TransactionRow>; today: string; index: number }) {
  const id = `feed-day-${index}`;
  return (
    <section aria-labelledby={id} className="feed-day relative">
      {/* The group header, on the canvas: the day bold, its date and counts
          grey. Opaque (the canvas), so rows passing under it never show. */}
      <h3
        id={id}
        className="feed-day-head sticky z-20 -mx-1 flex h-12 items-end gap-2 px-1 pb-2 text-[13px] sm:-mx-2 sm:px-2"
      >
        <span className="font-display text-[17px] font-semibold leading-tight tracking-[-0.018em] text-foreground">{day.label}</span>
        {day.date ? <span className="tabular leading-tight text-muted-foreground">{day.date}</span> : null}
        {day.future ? (
          <span
            className="rounded-full bg-attention-soft px-2 py-px text-[12px] font-medium leading-tight text-attention"
            title="This trade date is later than today: the filing's own date, reproduced as filed rather than corrected"
          >
            future date as filed
          </span>
        ) : null}
        {day.key === null ? null : (
          <span className="hidden leading-tight text-muted-foreground sm:inline">traded</span>
        )}
        <span className="flex-1" />
        <span className="tabular leading-tight text-muted-foreground">
          {day.trades} {day.trades === 1 ? "trade" : "trades"}
          <span aria-hidden> · </span>
          {day.filings} {day.filings === 1 ? "filing" : "filings"}
        </span>
      </h3>
      {/* One grouped tile per day; filings separated by hairlines that start
          at the member's name, not the tile's edge (.inset-rows). */}
      <ol className="tile inset-rows mb-2 [--sep-inset:3.25rem] sm:[--sep-inset:3.25rem]">
        {day.blocks.map((b, i) => (
          <FilingBlockView key={`${b.key}-${i}`} block={b} today={today} />
        ))}
      </ol>
    </section>
  );
}

/**
 * One filing's trades on one day. From 1024px the member sits in a left
 * column whose first line is the same 36px tall as a trade row, so the
 * avatar and name centre on the first trade; the meta line sits under the
 * name, indented to it. Below that the member is one line above the rows.
 */
function FilingBlockView({ block, today }: { block: FilingBlock<TransactionRow>; today: string }) {
  const r0 = block.rows[0];
  const n = block.rows.length;
  const label = memberLabel(r0.member_name, null, r0.state, r0.district, r0.chamber);
  const filed = r0.filing_date ? monthDay(r0.filing_date, today) : null;
  return (
    <li className="feed-block px-3.5 sm:px-5 lg:grid lg:grid-cols-[15.5rem_minmax(0,1fr)]">
      <div className="pt-3 lg:py-2 lg:pr-3">
        <div className="feed-member flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 lg:flex-col lg:flex-nowrap lg:items-start lg:gap-0">
          <div className="flex min-w-0 max-w-full items-center gap-2 lg:w-full lg:items-start">
            <span className="flex shrink-0 items-center lg:h-9">
              <MemberAvatar name={r0.member_name} bioguideId={r0.bioguide_id} size="sm" />
            </span>
            <a
              href={memberHref(r0.member_name, r0.bioguide_id)}
              className="min-w-0 truncate rounded-sm text-[14px] font-semibold tracking-[-0.01em] decoration-border-strong underline-offset-[3px] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring lg:line-clamp-2 lg:whitespace-normal lg:py-[9px] lg:leading-[18px]"
              title={label}
            >
              {label}
            </a>
            <span className="flex shrink-0 items-center lg:h-9">
              <PartyBadge party={r0.party} />
            </span>
          </div>
          <div className="tabular flex shrink-0 items-center gap-1 pl-8 text-[12px] text-muted-foreground max-sm:basis-full sm:ml-auto sm:pl-0 lg:-mt-1.5 lg:ml-8">
            {n > 1 ? (
              <span>
                {n} trades
                <span aria-hidden className="text-muted-foreground"> · </span>
              </span>
            ) : null}
            {filed ? (
              <span>
                filed {filed}
                <span aria-hidden className="text-muted-foreground"> · </span>
              </span>
            ) : null}
            <a
              href={r0.pdf_url}
              target="_blank"
              rel="noreferrer"
              className="rounded-sm underline decoration-border-strong underline-offset-[3px] transition-colors duration-(--dur-fast) hover:text-foreground hover:decoration-current focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              filing<span aria-hidden>&nbsp;↗</span>
              <span className="sr-only"> (opens the original filing)</span>
            </a>
          </div>
        </div>
      </div>
      <ul className="-mx-1.5 pb-2.5 pt-1.5 lg:mx-0 lg:py-2">
        {block.rows.map((r) => (
          <FeedRow key={r.id} r={r} />
        ))}
      </ul>
    </li>
  );
}

function FeedRow({ r }: { r: TransactionRow }) {
  return (
    <li className="feed-row rounded-[10px] px-1.5 py-1 transition-colors duration-(--dur-fast) hover:bg-foreground/[0.04] focus-within:bg-foreground/[0.04] sm:min-h-9">
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
      <span className="flex min-w-0 items-center gap-1.5 text-[14px] [grid-area:asset]">
        <AssetName name={r.asset_name} ticker={r.ticker} />
        <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap empty:hidden">
          <OptionBadge kind={r.option_kind} strikeCents={r.strike_cents} expiry={r.expiry} />
          <OwnerTag owner={r.owner} />
          <ScanTag transcribed={r.transcribed} docId={r.doc_id} />
        </span>
        {/* Below 640px the delay ends the asset line; above, it has a column. */}
        <span className="ml-auto shrink-0 pl-1 sm:hidden">
          <TradeDelay r={r} />
        </span>
      </span>
      <span className="hidden justify-self-end whitespace-nowrap text-right [grid-area:delay] sm:block">
        <TradeDelay r={r} />
      </span>
    </li>
  );
}
