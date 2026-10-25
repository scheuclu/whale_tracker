import Link from "next/link";
import { ArrowDownRight, ArrowLeftRight, ArrowUpRight, ChevronRight, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  ACTION_LABEL,
  ASSET_TYPE_LABEL,
  OWNER_LABEL,
  isBuy,
  isSell,
  optionLabel,
  range,
  tickerHref,
} from "@/lib/format";
import { PARTY_LABEL } from "@/lib/members";
import { Card } from "./charts";
import { ScrollX } from "./scroll-area";
import { MoneyText } from "./money";

export { MoneyText };

/**
 * The frame every `<table>` goes in. The leaderboards are 7–9 columns wide
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
  // In a tile, like an iOS inset-grouped table (`.grouped-table` in
  // globals.css): the cells keep a 16px inset from the tile's edge, the row
  // separators stop at that inset, and the tile clips (overflow: clip, not
  // hidden, so a sticky header can still reach the page) to its rounded
  // corners. On a phone a table wider than the tile says so above its rows.
  return (
    <Card className={cn("grouped-table overflow-clip p-0 sm:p-0", className)}>
      {/* Above the rows, so a long table says it scrolls before the reader has passed it. */}
      <p aria-hidden className="scroll-hint items-center justify-end gap-0.5 px-4 pt-2.5 text-[12px] text-muted-foreground">
        Swipe for more columns
        <ChevronRight className="size-3.5" strokeWidth={2.25} />
      </p>
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

/* ------------------------------------------------------------------
   The badge system. Every inline marker on a row — direction, party,
   owner, sector, option, role, plan, scan — is one of three shapes at one
   height (20px), one type size (11px) and one horizontal padding:

     chip    6px radius   facts about the trade (direction, ticker, tags)
     pill    fully round  states of a filing (StatusBadge), with a dot
     text    no box       figures (DelayTag, Amount): numbers are not chips

   Tone is a soft tint with no border, except where a hairline is the point
   (the ticker link, a filer-asserted plan, an option contract). Colour is
   never the only carrier: every badge spells its meaning in words.
   ------------------------------------------------------------------ */

const CHIP = "inline-flex h-[22px] shrink-0 align-middle items-center gap-1 whitespace-nowrap rounded-chip px-2 text-[12px] leading-none tracking-[-0.005em]";
const NEUTRAL = "bg-fill text-ink-2";
const HAIRLINE = "ring-1 ring-inset ring-border";
/** A transcribed (scanned) row: neutral and dashed — provisional, not a colour. */
const SCAN = "border border-dashed border-border-strong text-ink-2";
/** Focus ring for every link and control: 2px primary, offset off the surface. */
export const FOCUS_RING =
  "outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/** A neutral chip; `variant` picks the hairline or mono flavours. */
export function Tag({
  children,
  title,
  variant = "soft",
  className,
}: {
  children: React.ReactNode;
  title?: string;
  variant?: "soft" | "outline" | "mono";
  className?: string;
}) {
  return (
    <span
      className={cn(
        CHIP,
        variant === "soft" && NEUTRAL,
        variant === "outline" && cn(HAIRLINE, "text-muted-foreground"),
        variant === "mono" && "bg-fill font-medium text-ink-2 tabular",
        className
      )}
      title={title}
    >
      {children}
    </span>
  );
}

/**
 * Direction chips: "↗ Buy" / "↘ Sell" as tinted pills, Apple blue and
 * orange at 15–20%. The glyph and the word carry the direction; the tint
 * only echoes the chart marks. The text is the darker `--viz-*-text` of
 * the same hue, never the mark colour (light orange is 2.5:1 on white):
 * 5.4:1 light on the tile (5.0:1 on the canvas), 5.4:1 / 6.7:1 dark.
 */
const BUY_TONE =
  "bg-[color-mix(in_srgb,var(--viz-buy)_14%,transparent)] dark:bg-[color-mix(in_srgb,var(--viz-buy)_20%,transparent)] text-(--viz-buy-text) border border-[color-mix(in_srgb,var(--viz-buy)_24%,transparent)]";
const SELL_TONE =
  "bg-[color-mix(in_srgb,var(--viz-sell)_15%,transparent)] dark:bg-[color-mix(in_srgb,var(--viz-sell)_18%,transparent)] text-(--viz-sell-text) border border-[color-mix(in_srgb,var(--viz-sell)_25%,transparent)]";

const ACTION_TONE: Record<string, { cls: string; glyph: LucideIcon }> = {
  purchase: { cls: BUY_TONE, glyph: ArrowUpRight },
  sale: { cls: SELL_TONE, glyph: ArrowDownRight },
  sale_partial: { cls: SELL_TONE, glyph: ArrowDownRight },
  exchange: { cls: NEUTRAL, glyph: ArrowLeftRight },
};

export function ActionBadge({ action }: { action: string }) {
  const t = ACTION_TONE[action] ?? ACTION_TONE.exchange;
  const Glyph = t.glyph;
  return (
    <span className={cn(CHIP, "rounded-full gap-0.5 pl-1.5 pr-2.5 font-semibold", t.cls)}>
      <Glyph className="size-3 shrink-0" strokeWidth={2.4} aria-hidden />
      {ACTION_LABEL[action] ?? action}
    </span>
  );
}

/**
 * The status accents as small marks beside ink text (iOS Settings), each
 * with its own shape: a green dot for ok, a grey triangle for attention, a
 * red diamond for an error. Attention is a shape, not orange, because
 * orange is "sold" and a sell mark is a dot. Classes, so a pill, a page
 * header badge and a sentence all draw the same mark; the triangle
 * overrides whatever size and rounding the host gives a dot.
 */
const TRIANGLE = "bg-attention rounded-none! h-[7px]! w-2! [clip-path:polygon(50%_0,100%_100%,0_100%)]";
export const STATUS_MARK = {
  ok: "bg-ok rounded-full",
  attention: TRIANGLE,
  error: "bg-error rounded-[1px]! rotate-45",
} as const;

/**
 * Filing states, the way iOS Settings shows one: a grey pill with the word
 * in ink and a small status mark — a green dot (alerted), a grey triangle
 * (in flight / needs attention), a red diamond (unreadable), a grey or ink
 * dot (history, sending). The pill itself is never tinted; the word carries
 * the state and the mark's shape, not only its colour, sets each apart.
 */
const PILL = "bg-fill text-ink-2";
const OK = { cls: PILL, dot: "bg-ok" };
const GREY = { cls: PILL, dot: "bg-muted-foreground" };
const WARN = { cls: PILL, dot: STATUS_MARK.attention };

const STATUS_TONE: Record<string, { label: string; cls: string; dot: string }> = {
  notified: { label: "alerted", ...OK },
  backfilled: { label: "history", ...GREY },
  parsed: { label: "sending", cls: PILL, dot: "bg-foreground" },
  new: { label: "processing", cls: PILL, dot: cn(STATUS_MARK.attention, "motion-safe:animate-pulse") },
  backfill_queued: { label: "queued", ...WARN },
  failed: {
    label: "unreadable",
    // A diamond rather than a dot, and a hairline round the pill: the
    // error reads by shape and word, not by the red alone.
    cls: cn(PILL, "text-foreground ring-1 ring-inset ring-border-strong"),
    dot: STATUS_MARK.error,
  },
  seen_skipped: { label: "indexed", ...GREY },
  // A scan the grid reader has captured but no model has transcribed: the
  // filing's status is still `failed`, yet "unreadable" would be false — its
  // boxes were read, only the written text is missing.
  not_transcribed: { label: "not transcribed", ...WARN },
};

/**
 * A status accent in running text: the small mark, then the sentence in the
 * text ink. Use it wherever a warning or error used to be coloured text.
 */
export function StatusNote({
  tone,
  children,
  className,
  as: As = "span",
  title,
}: {
  tone: keyof typeof STATUS_MARK;
  children: React.ReactNode;
  className?: string;
  as?: "span" | "p" | "div";
  title?: string;
}) {
  return (
    <As className={cn(As === "span" ? "inline" : "block", className)} title={title}>
      <span
        aria-hidden
        className={cn("mr-1.5 inline-block size-1.5 shrink-0", tone === "error" && "mx-0.5 mr-2 size-[7px]", STATUS_MARK[tone])}
        style={{ verticalAlign: "0.12em" }}
      />
      {children}
    </As>
  );
}

export function Pill({ tone, dot, children }: { tone: string; dot: string; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex h-[22px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full align-middle px-2.5 text-[12px] font-medium leading-none",
        tone
      )}
    >
      <span className={cn("size-1.5 shrink-0 rounded-full", dot)} aria-hidden />
      {children}
    </span>
  );
}

export function StatusBadge({ value }: { value: string }) {
  const s = STATUS_TONE[value] ?? { label: value, ...GREY };
  return (
    <Pill tone={s.cls} dot={s.dot}>
      {s.label}
    </Pill>
  );
}

/**
 * Party as a neutral letter (or, with `full`, the word). Never tinted: the
 * page has no party colours, and a blue Democrat would read as "bought".
 */
export function PartyBadge({ party, full = false }: { party: string | null; full?: boolean }) {
  if (!party) return null;
  const label = PARTY_LABEL[party] ?? party;
  return (
    <span
      className={cn(
        CHIP,
        "justify-center bg-fill font-semibold text-ink-2",
        full ? "px-2" : "w-[22px] rounded-full px-0 text-[11px]"
      )}
      title={label}
    >
      {full ? label : party}
    </span>
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
      href={href ?? tickerHref(ticker)}
      className={cn(
        CHIP,
        FOCUS_RING,
        "rounded-[7px] bg-fill/85 px-2.5 text-[12.5px] font-semibold tracking-[0.005em] text-foreground ring-1 ring-black/[0.05] dark:ring-white/[0.08]",
        "transition-all duration-(--dur) ease-(--ease-out)",
        "hover:bg-accent hover:ring-black/[0.1] dark:hover:ring-white/[0.16] active:bg-foreground/[0.2]"
      )}
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
  const cls = cn(CHIP, SCAN);
  const title =
    "Read from a scanned paper filing (text by a vision model, ticked boxes by the grid reader). Counted as a trade; excluded from every volume total.";
  if (docId) {
    return (
      <Link
        href={`/scans/${encodeURIComponent(docId)}`}
        className={cn(cls, FOCUS_RING, "transition-[border-color,color] duration-(--dur) ease-(--ease-out) hover:border-foreground hover:text-foreground")}
        title={`${title} Click to inspect the scan.`}
      >
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

/**
 * The issuer's industry group, folded from its EDGAR SIC code
 * (src/whale/issuers.py). Nothing is rendered for an unclassified row: an
 * issuer EDGAR gives no SIC — an ETF trust, a fund — stays unknown rather
 * than being guessed at from its name.
 */
export function SectorTag({
  group,
  sic,
  description,
}: {
  group: string | null | undefined;
  sic?: string | null;
  description?: string | null;
}) {
  if (!group) return null;
  const detail = [description, sic ? `SIC ${sic}` : null].filter(Boolean).join(" · ");
  return (
    <Tag
      title={detail ? `${detail} — industry group from the issuer's EDGAR SIC code` : "Industry group from the issuer's EDGAR SIC code"}
    >
      {group}
    </Tag>
  );
}

/**
 * The option contract a row's own text named: kind, strike, expiry. Neutral
 * on purpose — the action badge already carries the buy/sell colour, and a
 * sold call coloured "buy" would contradict it. The words carry the meaning.
 */
export function OptionBadge({
  kind,
  strikeCents,
  expiry,
}: {
  kind: string | null | undefined;
  strikeCents: number | null | undefined;
  expiry: string | null | undefined;
}) {
  const label = optionLabel(kind ?? null, strikeCents ?? null, expiry ?? null);
  if (!label) return null;
  return (
    <Tag
      variant="mono"
      className="tabular"
      title="Option contract as the filing's own text describes it: kind, strike and expiry are shown only when printed"
    >
      {label}
    </Tag>
  );
}

export function OwnerTag({ owner }: { owner: string | null }) {
  if (!owner || !OWNER_LABEL[owner]) return null;
  return <Tag>{OWNER_LABEL[owner]}</Tag>;
}

/** A late delay is ink at medium weight with the word "late"; no colour. */
const LATE_INK = "text-foreground";

/**
 * "date as filed": a row whose dates contradict each other, reproduced
 * rather than corrected. Secondary ink with a small attention dot.
 */
export function AsFiled({ title }: { title: string }) {
  return (
    <StatusNote tone="attention" className="whitespace-nowrap text-[11px] text-ink-2" title={title}>
      date as filed
    </StatusNote>
  );
}

/** "13d" / "49d late": the figure at full weight, the unit and verdict lighter. */
function Days({ days, late }: { days: number; late: boolean }) {
  return (
    <>
      {days}
      <span className={cn("text-[0.9em]", !late && "text-muted-foreground")}>d</span>
      {late ? <span className="font-normal"> late</span> : null}
    </>
  );
}

/**
 * Disclosure delay against the STOCK Act's 45-day deadline — the one
 * compliance fact these filings actually prove.
 */
export function DelayTag({ days, inconsistent }: { days: number | null; inconsistent?: number }) {
  if (inconsistent) {
    return (
      <AsFiled title="The filing's trade and notification dates contradict each other — reproduced as filed" />
    );
  }
  if (days == null) return null;
  const late = days > 45;
  return (
    <span
      className={cn(
        "tabular whitespace-nowrap text-[11px]",
        late ? cn("font-medium", LATE_INK) : "text-muted-foreground"
      )}
      title={
        late
          ? "Filed past the STOCK Act's 45-day deadline"
          : "Days from the trade to the report reaching the Clerk"
      }
    >
      <Days days={days} late={late} />
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
      <AsFiled title="The trade and filing dates could not be compared (malformed or contradictory) — reproduced as filed" />
    );
  }
  const isLate = late === 1;
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={cn(
          "tabular whitespace-nowrap text-[11px]",
          isLate ? cn("font-medium", LATE_INK) : "text-muted-foreground"
        )}
        title={
          isLate
            ? "Filed more than two business days after the trade — Form 4's deadline"
            : "Days from the trade to the filing reaching EDGAR"
        }
      >
        <Days days={days} late={isLate} />
      </span>
      {timeliness === "L" ? (
        <span className={cn(CHIP, NEUTRAL)} title="The filer ticked the form's own 'late' box">
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
    <span className="inline-flex min-w-0 items-center gap-1">
      {parts.length ? (
        <Tag className="block max-w-[16rem] truncate leading-5" title={parts.join(" · ")}>
          {parts.join(" · ")}
        </Tag>
      ) : null}
      {joint ? (
        <Tag variant="outline" title="Filed jointly with related reporting owners — counted as one insider">
          {joint}
        </Tag>
      ) : null}
    </span>
  );
}

/** The Rule 10b5-1 checkbox: the filer asserts the trade ran under a pre-arranged plan. */
export function PlanTag({ value }: { value: number | null }) {
  if (value !== 1) return null;
  return (
    <Tag
      variant="outline"
      title="Filer asserts the trade was made under a pre-arranged Rule 10b5-1 trading plan"
    >
      10b5-1 plan
    </Tag>
  );
}

/**
 * The disclosed bracket (or the exact figure where one was filed), in
 * tabular figures with the currency and unit set lighter. Never a midpoint.
 */
export function Amount({
  min,
  max,
  exact,
}: {
  min: number | null;
  max: number | null;
  exact: number | null;
}) {
  return <MoneyText value={range(min, max, exact)} className="text-[13px]" />;
}

/* ------------------------------------------------------------------
   Controls, iOS-style. Buttons are capsules: a grey fill for the
   secondary, graphite for the one primary (white in dark mode) — never
   blue, which means "bought". Fields are grey filled rounded rects (12px),
   no border. The segmented control is a grey track with the selected
   option raised as a white chip.
   ------------------------------------------------------------------ */

/** A secondary button / link-button: a grey capsule. */
export const BUTTON = cn(
  "inline-flex h-8.5 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-full",
  "bg-fill/85 px-4 text-[13px] font-medium text-foreground ring-1 ring-black/[0.05] dark:ring-white/[0.08] shadow-[inset_0_1px_0_rgba(255,255,255,0.6)] dark:shadow-none",
  "transition-all duration-(--dur) ease-(--ease-out)",
  "hover:bg-foreground/[0.1] active:scale-[0.98] active:bg-foreground/[0.16]",
  FOCUS_RING
);
/** The one filled button in a form: its submit. A graphite capsule. */
export const BUTTON_PRIMARY = cn(
  "inline-flex h-8.5 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-primary px-4.5",
  "text-[13px] font-semibold text-primary-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.22),0_2px_6px_rgba(0,0,0,0.14)]",
  "transition-all duration-(--dur) ease-(--ease-out) hover:opacity-92 active:scale-[0.98] active:opacity-85",
  FOCUS_RING
);

/** Text inputs and selects: one height, radius, hover and focus treatment. */
export const FIELD = cn(
  "h-9 w-full min-w-0 rounded-control border border-black/[0.05] dark:border-white/[0.08] bg-[var(--field)] px-3 text-[14px] text-foreground shadow-[inset_0_1px_2px_rgba(0,0,0,0.04)]",
  "transition-all duration-(--dur) ease-(--ease-out) dark:[color-scheme:dark]",
  "hover:bg-foreground/[0.09] focus:bg-card",
  "placeholder:text-muted-foreground"
);

/** One option of a segmented control (see `Segmented`). */
export function segmentClass(active: boolean) {
  return cn(
    "inline-flex h-7 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-[13px] sm:px-3.5",
    "transition-all duration-(--dur) ease-(--ease-out)",
    FOCUS_RING,
    "focus-visible:outline-offset-1",
    active
      ? "bg-card font-semibold text-foreground shadow-segment ring-1 ring-black/[0.04] dark:bg-[#3a3a3c] dark:ring-white/[0.08] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_1px_3px_rgba(0,0,0,0.45)]"
      : "font-medium text-ink-2 hover:text-foreground active:bg-foreground/[0.06]"
  );
}

/** The segmented control's track. */
export const SEGMENT_TRACK = "inline-flex max-w-full overflow-x-auto scrollbar-none items-center gap-0.5 rounded-full bg-fill/90 p-[3px] shadow-[inset_0_1px_2px_rgba(0,0,0,0.05)] dark:shadow-[inset_0_1px_2px_rgba(0,0,0,0.35)] border border-black/[0.04] dark:border-white/[0.07]";

export { SegmentedNav as Segmented } from "./segmented-nav";

export { isBuy, isSell };
