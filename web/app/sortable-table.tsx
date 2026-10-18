import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { nextSort, query, type Sort, type SortSpec } from "@/lib/table-sort";
import { SortLink } from "./table-client";

/**
 * The leaderboard toolkit: sortable header cells, in-cell magnitude bars and
 * a buy/sell split, shared by /politicians, /tickers and /insiders. Plain
 * `<table>` parts only, so a table built from them still sits directly in a
 * `ResponsiveTable` (horizontal scroll, pinned first column). The sticky
 * header and whole-row click target live in `table-client.tsx`.
 */

/** Class for the `<table>` itself: hooks the sticky-header and row styles in globals.css. */
export const DATA_TABLE = "data-table w-full text-[13px]";

/**
 * Class for the header `<tr>`: 12px muted, sentence case, no tracking — the
 * labels are written in sentence case at the call site and shown as written.
 */
export const HEAD_ROW = "text-left text-[12px] font-medium text-muted-foreground";

/**
 * Class for a body `<tr>` that links to a detail page. Hairline rules, no
 * zebra: every table on the site separates rows the same way. Keyboard focus
 * on the row's own link lights the row the way a pointer hover does.
 */
export const BODY_ROW =
  "data-row border-b border-border/60 last:border-0 has-[a:focus-visible]:bg-[color-mix(in_srgb,var(--foreground)_4.5%,transparent)]";

/**
 * The same header and row treatment for a plain `<table>` that is not a
 * leaderboard (no sticky header, no row link): a hairline under the header,
 * hairlines between rows, a quiet hover.
 */
export const PLAIN_HEAD_ROW = "border-b border-border text-left text-[12px] font-medium text-muted-foreground";
export const PLAIN_BODY_ROW =
  "border-b border-border/60 transition-colors duration-(--dur-fast) last:border-0 hover:bg-raised";

/**
 * Builds the URL a header links to: the page's own parameters (window,
 * filters, row count) kept, the sort replaced, and a fragment so a no-JS
 * full reload lands back on the table rather than at the top of the page.
 */
export function sortHref<K extends string>(
  spec: SortSpec<K>,
  sort: Sort<K>,
  key: K,
  base: { path: string; keep?: Record<string, string | undefined>; hash?: string }
): string {
  return `${base.path}${query({ ...base.keep, ...nextSort(spec, sort, key) })}${base.hash ? `#${base.hash}` : ""}`;
}

/**
 * A header cell that sorts its column. A real link (works without JS, can be
 * opened in a tab, shareable), `aria-sort` on the active column, an arrow
 * for the direction and words for screen readers. `hint` explains what the
 * column measures — shown on hover and on keyboard focus, and announced as
 * the link's description.
 */
export function SortHeader<K extends string>({
  spec,
  sort,
  column,
  href,
  children,
  align = "right",
  hint,
  className,
}: {
  spec: SortSpec<K>;
  sort: Sort<K>;
  column: K;
  href: string;
  children: React.ReactNode;
  align?: "left" | "right";
  hint?: string;
  className?: string;
}) {
  const active = sort.key === column;
  const dir = active ? sort.dir : spec.columns[column].first;
  const Icon = !active ? ChevronsUpDown : dir === "asc" ? ArrowUp : ArrowDown;
  const hintId = hint ? `sort-hint-${column}` : undefined;
  const nextDir = active ? (sort.dir === "asc" ? "descending" : "ascending") : dir === "asc" ? "ascending" : "descending";
  return (
    <th
      scope="col"
      aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}
      className={cn("p-0 font-medium", align === "right" ? "text-right" : "text-left", className)}
    >
      <SortLink
        href={href}
        aria-describedby={hintId}
        className={cn(
          "group/sort relative flex items-center gap-1 px-3 py-2.5 outline-none transition-colors duration-(--dur-fast)",
          "hover:text-foreground focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
          // A right-aligned column puts its arrow before the label, so the
          // label's right edge lines up with the figures beneath it.
          align === "right" ? "flex-row-reverse justify-start" : "justify-start",
          active && "text-foreground"
        )}
      >
        <span className={cn(hint && "underline decoration-dotted decoration-muted-foreground/40 underline-offset-[4px]")}>
          {children}
        </span>
        <Icon
          aria-hidden
          className={cn(
            "size-3 shrink-0 transition-opacity duration-(--dur-fast)",
            active ? "text-primary" : "opacity-0 group-hover/sort:opacity-60 group-focus-visible/sort:opacity-60"
          )}
          strokeWidth={2.25}
        />
        <span className="sr-only">
          {active ? `, sorted ${sort.dir === "asc" ? "ascending" : "descending"}. ` : ". "}
          Sort {nextDir}
        </span>
        {hint ? (
          <span
            id={hintId}
            role="tooltip"
            className={cn(
              "pointer-events-none absolute top-full z-20 mt-1 w-64 rounded-lg border border-border bg-popover px-3 py-2",
              "text-left text-[12px] font-normal normal-case leading-snug tracking-normal whitespace-normal text-popover-foreground shadow-md",
              "invisible opacity-0 transition-opacity delay-0 group-hover/sort:visible group-hover/sort:opacity-100 group-hover/sort:delay-300",
              "group-focus-visible/sort:visible group-focus-visible/sort:opacity-100",
              align === "right" ? "right-2" : "left-2"
            )}
          >
            {hint}
          </span>
        ) : null}
      </SortLink>
    </th>
  );
}

/** A plain, unsortable header cell in the same type ramp. */
export function PlainHeader({
  children,
  align = "left",
  className,
}: {
  children?: React.ReactNode;
  align?: "left" | "right";
  className?: string;
}) {
  return (
    <th scope="col" className={cn("px-3 py-2.5 font-medium", align === "right" && "text-right", className)}>
      {children}
    </th>
  );
}

/**
 * A number with a magnitude bar behind it: a light tint anchored at the
 * right edge, where the right-aligned figures line up, growing left over a
 * fixed width, so every row shares one baseline and one scale. Linear from
 * zero and scaled to `max` — the largest value in the whole result, not the
 * rows on screen — so a bar means the same length whichever way the table is
 * sorted. There is no empty track: a small value is a sliver under its own
 * number, and an empty or unknown one has no mark at all (an empty bar would
 * read as a measured zero). The printed value is the datum.
 */
export function BarCell({
  value,
  max,
  children,
  tone = "seq",
  className,
  title,
}: {
  value: number | null;
  max: number;
  children: React.ReactNode;
  title?: string;
  /** `seq` for a plain magnitude; `buy`/`sell` only where the column is one direction. */
  tone?: "seq" | "buy" | "sell";
  className?: string;
}) {
  const pct = value && value > 0 && max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <td className={cn("tabular px-3 py-2 text-right", className)} title={title}>
      <span className="relative inline-block w-[4.5rem] py-0.5 pr-1.5 sm:w-[5.5rem]">
        {pct ? (
          // max(2px, …): the smallest nonzero value still leaves a visible edge.
          <span
            aria-hidden
            className={cn("pointer-events-none absolute inset-y-0 right-0 rounded-[4px_1px_1px_4px]", BAR_TINT[tone])}
            style={{ width: `max(2px, ${pct}%)` }}
          />
        ) : null}
        <span className="relative">{children}</span>
      </span>
    </td>
  );
}

/**
 * The bar tints: a step quieter than a chart mark (13% light, 17% dark), so a
 * column of bars reads as texture behind the figures rather than as a second,
 * louder number. The hues are the `--viz-*` roles; only the strength is set
 * here.
 */
const BAR_TINT = {
  seq: "bg-[color-mix(in_oklab,var(--viz-seq)_13%,transparent)] dark:bg-[color-mix(in_oklab,var(--viz-seq)_17%,transparent)]",
  buy: "bg-[color-mix(in_oklab,var(--viz-buy)_13%,transparent)] dark:bg-[color-mix(in_oklab,var(--viz-buy)_17%,transparent)]",
  sell: "bg-[color-mix(in_oklab,var(--viz-sell)_13%,transparent)] dark:bg-[color-mix(in_oklab,var(--viz-sell)_17%,transparent)]",
} as const;

/**
 * Buys and sells, printed as "12 / 30" with a two-segment bar after it:
 * the buy share in the buy colour, the sell share in the sell colour, a
 * surface gap between. The header names the order, the screen-reader text
 * names both counts, and colour never carries the direction alone.
 */
export function SplitCell({ buys, sells, className }: { buys: number; sells: number; className?: string }) {
  const total = buys + sells;
  const buyPct = total ? (buys / total) * 100 : 0;
  return (
    <td className={cn("tabular px-3 py-2 text-right text-muted-foreground", className)}>
      <span className="inline-flex items-center justify-end gap-2">
        <span>
          <span aria-hidden>
            <span className="text-ink-2">{buys}</span> / <span className="text-ink-2">{sells}</span>
          </span>
          <span className="sr-only">
            {buys} {buys === 1 ? "buy" : "buys"}, {sells} {sells === 1 ? "sell" : "sells"}
          </span>
        </span>
        <span
          aria-hidden
          className="split-track flex h-1.5 w-10 shrink-0 gap-[2px] overflow-hidden rounded-[2px]"
          title={total ? `${Math.round(buyPct)}% buys` : "no buys or sells"}
        >
          {buys ? <span className="bar-buy block h-full rounded-[1px]" style={{ flexGrow: buys }} /> : null}
          {sells ? <span className="bar-sell block h-full rounded-[1px]" style={{ flexGrow: sells }} /> : null}
        </span>
      </span>
    </td>
  );
}

/**
 * The late count: a quiet chip when there are any, a dash when none. Not
 * red — red is the sell colour on this dashboard — and a late count is a
 * reporting fact, not an alarm.
 */
export function LateCell({ count, of, className }: { count: number; of?: number; className?: string }) {
  return (
    <td className={cn("tabular px-3 py-2 text-right", className)}>
      {count > 0 ? (
        <span
          className="late-chip inline-flex min-w-7 justify-center rounded-md px-1.5 py-px font-medium"
          title={of ? `${count} of ${of} trades filed past the deadline` : undefined}
        >
          {count}
        </span>
      ) : (
        <span className="text-muted-foreground">—</span>
      )}
    </td>
  );
}

/**
 * "estimated volume, highest first" — the order in words, for the footer.
 * Names sort A–Z first; measures highest first; `phrases` overrides either
 * (a date reads better as "newest first").
 */
export function describeSort<K extends string>(
  spec: SortSpec<K>,
  sort: Sort<K>,
  names: Record<K, string>,
  phrases?: Partial<Record<K, { asc: string; desc: string }>>
): string {
  const text = spec.columns[sort.key].first === "asc";
  const p = phrases?.[sort.key] ?? (text ? { asc: "A–Z", desc: "Z–A" } : { asc: "lowest first", desc: "highest first" });
  return `${names[sort.key]}, ${p[sort.dir]}`;
}

/**
 * The line under a truncated leaderboard: how many of how many it shows and
 * in what order, with links to show more. A table that silently stops at 40
 * would read as the whole set.
 */
export function TableFooter({
  shown,
  total,
  noun,
  orderLabel,
  moreHref,
  allHref,
}: {
  shown: number;
  total: number;
  noun: string;
  orderLabel: string;
  moreHref?: string;
  allHref?: string;
}) {
  return (
    <p className="tabular mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted-foreground">
      <span>
        {shown < total ? `${shown} of ${total.toLocaleString()} ${noun}` : `All ${total.toLocaleString()} ${noun}`}, by{" "}
        {orderLabel}
      </span>
      {shown < total && moreHref ? (
        <SortLink href={moreHref} jump={false} className={FOOTER_LINK}>
          show {Math.min(total, 200)}
        </SortLink>
      ) : null}
      {shown < total && allHref ? (
        <SortLink href={allHref} jump={false} className={FOOTER_LINK}>
          show all
        </SortLink>
      ) : null}
    </p>
  );
}

const FOOTER_LINK =
  "rounded-sm text-ink-2 underline decoration-border underline-offset-[3px] transition-colors duration-(--dur-fast) hover:text-primary hover:decoration-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
