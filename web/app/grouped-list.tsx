import { cn } from "@/lib/utils";
import { Card } from "./charts";

/**
 * An iOS inset-grouped list: one tile, rows separated by hairlines inset
 * from the tile's left edge (`.inset-rows` in globals.css). For lists of
 * people and issuers that are not tables — who traded a ticker, the
 * insiders behind an issuer, search results. An optional `header` (a
 * summary sentence) and `footer` (a caveat, a "see all" link) sit inside the
 * same tile, above and below the rows.
 */
export function GroupedList({
  children,
  header,
  footer,
  inset,
  className,
}: {
  children: React.ReactNode;
  header?: React.ReactNode;
  footer?: React.ReactNode;
  /** Where the separators start: the rows' text edge (past an avatar, say). */
  inset?: string;
  className?: string;
}) {
  return (
    <Card className={cn("overflow-hidden p-0 sm:p-0", className)}>
      {header ? <div className="px-4 pb-2 pt-4 sm:px-5 sm:pt-5">{header}</div> : null}
      <ul
        className={cn("inset-rows py-1", !inset && "[--sep-inset:1rem] sm:[--sep-inset:1.25rem]")}
        style={inset ? ({ "--sep-inset": inset } as React.CSSProperties) : undefined}
      >
        {children}
      </ul>
      {footer ? <div className="space-y-2 px-4 pb-4 pt-2 sm:px-5 sm:pb-5">{footer}</div> : null}
    </Card>
  );
}

/** One row of a `GroupedList`: 44px minimum, the text inset 16px (20px from 640px). */
export const GROUPED_ROW =
  "flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-[14px] sm:px-5";

/**
 * A two-column row of a `GroupedList`, Settings-style: the name (and its
 * tags beneath it) on the left, the figure over its context on the right.
 * Two fixed columns rather than one wrapping line, so a long name never
 * pushes the figures onto a ragged second line on a phone.
 */
export function ValueRow({
  name,
  tags,
  value,
  meta,
  className,
}: {
  name: React.ReactNode;
  tags?: React.ReactNode;
  value?: React.ReactNode;
  meta?: React.ReactNode;
  className?: string;
}) {
  return (
    <li className={cn("grid min-h-11 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 px-4 py-2.5 sm:px-5", className)}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 text-[14px]">
        {name}
        {tags}
      </div>
      <div className="flex flex-col items-end text-right sm:flex-row-reverse sm:items-baseline sm:gap-4">
        {value ? <span className="tabular whitespace-nowrap text-[14px] text-foreground">{value}</span> : null}
        {meta ? <span className="tabular whitespace-nowrap text-[12px] text-muted-foreground sm:text-[13px]">{meta}</span> : null}
      </div>
    </li>
  );
}

/** A row's name link: ink, underlined only on hover (the row is the target). */
export const ROW_LINK =
  "rounded-sm font-semibold text-foreground underline decoration-transparent underline-offset-[3px] transition-[text-decoration-color] duration-(--dur-fast) hover:decoration-border-strong";

/** The "every … →" link at the foot of a grouped list. */
export const LIST_FOOT_LINK =
  "inline-flex items-center gap-1 rounded-sm text-[13px] font-medium text-ink-2 underline decoration-border-strong underline-offset-[3px] transition-colors duration-(--dur-fast) hover:text-foreground hover:decoration-current";
