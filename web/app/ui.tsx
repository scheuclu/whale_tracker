import Link from "next/link";
import { cn } from "@/lib/utils";
import {
  ACTION_LABEL,
  ASSET_TYPE_LABEL,
  OWNER_LABEL,
  isBuy,
  isSell,
  range,
} from "@/lib/format";
import { Card } from "./charts";
import { ScrollX } from "./scroll-area";

/**
 * The card every `<table>` goes in. The leaderboards are 7–9 columns wide
 * and do not fit a phone; rather than drop columns, the table scrolls
 * sideways inside a container that fades its open edge and pins the first
 * column (the ticker, member or filing id) so a row keeps its name while the
 * numbers move. It replaces `<Card className="overflow-x-auto p-0">`, which
 * scrolled silently:
 *
 *   <ResponsiveTable>
 *     <table className="w-full text-[13px]">…</table>
 *   </ResponsiveTable>
 *
 * Cells do not wrap: once the table is wider than its card it sits at its
 * min-content width, where "535 / 402" would break across three lines.
 * `wrap` restores wrapping for a table with a prose column.
 *
 * `lib/responsive-tables.test.ts` fails any page that renders a bare table.
 */
export function ResponsiveTable({
  children,
  className,
  stickyFirstColumn = true,
  wrap = false,
}: {
  children: React.ReactNode;
  /** Merged onto the card. */
  className?: string;
  /** Off for a table whose first column is not the row's identity. */
  stickyFirstColumn?: boolean;
  /** Let cells wrap (a column of free text) instead of extending the scroll. */
  wrap?: boolean;
}) {
  return (
    <Card className={cn("p-0", className)}>
      <ScrollX className={wrap ? undefined : "whitespace-nowrap"} stickyFirstColumn={stickyFirstColumn}>
        {children}
      </ScrollX>
    </Card>
  );
}

/**
 * A single row of chips or filter pills that is allowed to be wider than a
 * phone: it scrolls sideways with an edge fade instead of wrapping into a
 * ragged stack or pushing the page out.
 */
export function ScrollRow({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <ScrollX viewportClassName={cn("scrollbar-none flex items-center gap-1", className)}>{children}</ScrollX>
  );
}

/**
 * Direction pills. The dot carries the diverging colour and the word carries
 * the meaning, so a colour-blind reader loses nothing.
 */
const ACTION_TONE: Record<string, { cls: string; dot: string }> = {
  purchase: {
    cls: "text-[#1c5cab] dark:text-[#86b6ef] bg-[#2a78d6]/10 border-[#2a78d6]/25",
    dot: "bg-[var(--viz-buy)]",
  },
  sale: {
    cls: "text-[#a32c2c] dark:text-[#e89f9f] bg-[#d03b3b]/10 border-[#d03b3b]/25",
    dot: "bg-[var(--viz-sell)]",
  },
  sale_partial: {
    cls: "text-[#a32c2c] dark:text-[#e89f9f] bg-[#d03b3b]/10 border-[#d03b3b]/25",
    dot: "bg-[var(--viz-sell)]",
  },
  exchange: { cls: "text-muted-foreground bg-muted border-border", dot: "bg-zinc-400" },
};

const STATUS_TONE: Record<string, { label: string; cls: string; dot: string }> = {
  notified: {
    label: "alerted",
    cls: "text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border-emerald-500/25",
    dot: "bg-emerald-500",
  },
  backfilled: {
    label: "history",
    cls: "text-muted-foreground bg-muted border-border",
    dot: "bg-zinc-400",
  },
  parsed: { label: "sending", cls: "text-primary bg-primary/10 border-primary/25", dot: "bg-primary" },
  new: {
    label: "processing",
    cls: "text-amber-600 dark:text-amber-400 bg-amber-500/10 border-amber-500/25",
    dot: "bg-amber-500 animate-pulse",
  },
  backfill_queued: {
    label: "queued",
    cls: "text-amber-600 dark:text-amber-400 bg-amber-500/10 border-amber-500/25",
    dot: "bg-amber-500",
  },
  failed: {
    label: "unreadable",
    cls: "text-red-600 dark:text-red-400 bg-red-500/10 border-red-500/25",
    dot: "bg-red-500",
  },
  seen_skipped: {
    label: "indexed",
    cls: "text-muted-foreground bg-muted border-border",
    dot: "bg-zinc-400",
  },
  // A scan the grid reader has captured but no model has transcribed: the
  // filing's status is still `failed`, yet "unreadable" would be false — its
  // boxes were read, only the written text is missing.
  not_transcribed: {
    label: "not transcribed",
    cls: "text-amber-600 dark:text-amber-400 bg-amber-500/10 border-amber-500/25",
    dot: "bg-amber-500",
  },
};

function Pill({
  tone,
  dot,
  children,
}: {
  tone: string;
  dot: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-[11px] font-medium",
        tone
      )}
    >
      <span className={cn("size-1.5 rounded-full", dot)} />
      {children}
    </span>
  );
}

export function ActionBadge({ action }: { action: string }) {
  const t = ACTION_TONE[action] ?? ACTION_TONE.exchange;
  return (
    <Pill tone={t.cls} dot={t.dot}>
      {ACTION_LABEL[action] ?? action}
    </Pill>
  );
}

export function StatusBadge({ value }: { value: string }) {
  const s = STATUS_TONE[value] ?? {
    label: value,
    cls: "text-muted-foreground bg-muted border-border",
    dot: "bg-zinc-400",
  };
  return (
    <Pill tone={s.cls} dot={s.dot}>
      {s.label}
    </Pill>
  );
}

export function PartyBadge({ party }: { party: string | null }) {
  if (!party) return null;
  const cls =
    party === "D"
      ? "text-[#1c5cab] dark:text-[#86b6ef] border-[#2a78d6]/30"
      : party === "R"
        ? "text-[#a32c2c] dark:text-[#e89f9f] border-[#d03b3b]/30"
        : "text-muted-foreground border-border";
  return (
    <span className={cn("rounded border px-1.5 py-px text-[10px] font-bold", cls)}>{party}</span>
  );
}

export function TickerChip({
  ticker,
  type,
  href,
}: {
  ticker: string | null;
  type?: string | null;
  /** Defaults to the congressional ticker page; insider pages link to their own. */
  href?: string;
}) {
  if (!ticker) {
    return (
      <span
        className="text-xs text-muted-foreground"
        title={type ? ASSET_TYPE_LABEL[type] ?? type : undefined}
      >
        {type ? ASSET_TYPE_LABEL[type] ?? type : "no ticker"}
      </span>
    );
  }
  return (
    <Link
      href={href ?? `/tickers?t=${encodeURIComponent(ticker)}`}
      className="inline-flex items-center rounded-md border border-border bg-card px-2 py-0.5 font-mono text-xs font-semibold tracking-tight transition-colors hover:border-primary/40 hover:bg-accent"
    >
      {ticker}
    </Link>
  );
}

/**
 * A row read off a scanned paper filing: the text by a vision model, the
 * amount and type boxes by the grid reader. Shown with the bracket as read,
 * counted as a trade, and kept out of every volume figure on the site.
 */
export function ScanTag({
  transcribed,
  docId,
}: {
  transcribed: number | null | undefined;
  /** The filing's Clerk id: given, the tag links to its /scans inspection page. */
  docId?: string;
}) {
  if (!transcribed) return null;
  const cls =
    "rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-px text-[10px] text-amber-700 dark:text-amber-300";
  const title =
    "Read from a scanned paper filing (text by a vision model, ticked boxes by the grid reader). Counted as a trade; excluded from every volume total.";
  if (docId) {
    return (
      <Link href={`/scans/${encodeURIComponent(docId)}`} className={cn(cls, "hover:bg-amber-500/20")} title={`${title} Click to inspect the scan.`}>
        transcribed from scan
      </Link>
    );
  }
  return (
    <span className={cls} title={title}>
      transcribed from scan
    </span>
  );
}

export function OwnerTag({ owner }: { owner: string | null }) {
  if (!owner || !OWNER_LABEL[owner]) return null;
  return (
    <span className="rounded bg-muted px-1.5 py-px text-[10px] text-muted-foreground">
      {OWNER_LABEL[owner]}
    </span>
  );
}

/**
 * Disclosure delay against the STOCK Act's 45-day deadline — the one
 * compliance fact these filings actually prove.
 */
export function DelayTag({ days, inconsistent }: { days: number | null; inconsistent?: number }) {
  if (inconsistent) {
    return (
      <span
        className="text-[11px] text-amber-600 dark:text-amber-400"
        title="The filing's trade and notification dates contradict each other — reproduced as filed"
      >
        date as filed
      </span>
    );
  }
  if (days == null) return null;
  const late = days > 45;
  return (
    <span
      className={cn(
        "tabular text-[11px]",
        late ? "font-medium text-red-600 dark:text-red-400" : "text-muted-foreground"
      )}
      title={
        late
          ? "Filed past the STOCK Act's 45-day deadline"
          : "Days from the trade to the report reaching the Clerk"
      }
    >
      {days}d{late ? " late" : ""}
    </span>
  );
}

/**
 * Form 4's deadline is two business days, so the congressional DelayTag (45
 * days, STOCK Act copy) does not apply. `late` is derived once at ingest with
 * federal holidays excluded; the filer's own "late" box is shown separately
 * because it is a filed fact, not our computation.
 */
export function InsiderDelayTag({
  days,
  late,
  timeliness,
}: {
  days: number | null;
  late: number | null;
  timeliness: string | null;
}) {
  if (days == null) {
    return (
      <span
        className="text-[11px] text-amber-600 dark:text-amber-400"
        title="The trade and filing dates could not be compared (malformed or contradictory) — reproduced as filed"
      >
        date as filed
      </span>
    );
  }
  const isLate = late === 1;
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={cn(
          "tabular text-[11px]",
          isLate ? "font-medium text-red-600 dark:text-red-400" : "text-muted-foreground"
        )}
        title={
          isLate
            ? "Filed more than two business days after the trade — Form 4's deadline"
            : "Days from the trade to the filing reaching EDGAR"
        }
      >
        {days}d{isLate ? " late" : ""}
      </span>
      {timeliness === "L" ? (
        <span
          className="text-[10px] text-amber-600 dark:text-amber-400"
          title="The filer ticked the form's own 'late' box"
        >
          marked late by filer
        </span>
      ) : null}
    </span>
  );
}

/** The reporting owner's relationship to the issuer, as declared on the filing. */
export function RoleTag({
  isDirector,
  isOfficer,
  isTenPercentOwner,
  officerTitle,
  ownerCount,
}: {
  isDirector: number | null;
  isOfficer: number | null;
  isTenPercentOwner: number | null;
  officerTitle: string | null;
  ownerCount?: number;
}) {
  const parts = [
    isOfficer ? officerTitle ?? "Officer" : null,
    isDirector ? "Director" : null,
    isTenPercentOwner ? "10% owner" : null,
  ].filter(Boolean) as string[];
  const joint = ownerCount && ownerCount > 1 ? `+${ownerCount - 1} joint` : null;
  if (!parts.length && !joint) return null;
  return (
    <span className="inline-flex items-center gap-1">
      {parts.length ? (
        <span
          className="max-w-[16rem] truncate rounded bg-muted px-1.5 py-px text-[10px] text-muted-foreground"
          title={parts.join(" · ")}
        >
          {parts.join(" · ")}
        </span>
      ) : null}
      {joint ? (
        <span
          className="rounded bg-muted px-1.5 py-px text-[10px] text-muted-foreground"
          title="Filed jointly with related reporting owners — counted as one insider"
        >
          {joint}
        </span>
      ) : null}
    </span>
  );
}

/** The Rule 10b5-1 checkbox: the filer asserts the trade ran under a pre-arranged plan. */
export function PlanTag({ value }: { value: number | null }) {
  if (value !== 1) return null;
  return (
    <span
      className="rounded border border-border px-1.5 py-px text-[10px] text-muted-foreground"
      title="Filer asserts the trade was made under a pre-arranged Rule 10b5-1 trading plan"
    >
      10b5-1 plan
    </span>
  );
}

export function Amount({
  min,
  max,
  exact,
}: {
  min: number | null;
  max: number | null;
  exact: number | null;
}) {
  return <span className="tabular text-[13px]">{range(min, max, exact)}</span>;
}

export { isBuy, isSell };
