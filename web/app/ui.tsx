import Link from "next/link";
import { ArrowDownRight, ArrowLeftRight, ArrowUpRight, type LucideIcon } from "lucide-react";
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

const CHIP = "inline-flex h-5 shrink-0 align-middle items-center gap-1 whitespace-nowrap rounded-chip px-1.5 text-[11px] leading-none";
const NEUTRAL = "bg-muted text-muted-foreground";
const HAIRLINE = "ring-1 ring-inset ring-border";
const AMBER = "bg-attention-soft text-attention";
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
        variant === "mono" && cn(HAIRLINE, "bg-muted font-mono font-medium tracking-tight text-ink-2"),
        className
      )}
      title={title}
    >
      {children}
    </span>
  );
}

/**
 * Direction chips: a soft tint of the diverging buy/sell role, a direction
 * glyph and the word. The word carries the meaning, so a colour-blind reader
 * loses nothing; the ink is the role mixed toward the foreground so 11px text
 * clears contrast on both surfaces without inventing a new colour.
 */
const BUY_TONE =
  "bg-[color-mix(in_oklab,var(--viz-buy)_12%,transparent)] text-[color-mix(in_oklab,var(--viz-buy)_74%,var(--foreground))]";
const SELL_TONE =
  "bg-[color-mix(in_oklab,var(--viz-sell)_11%,transparent)] text-[color-mix(in_oklab,var(--viz-sell)_76%,var(--foreground))]";

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
    <span className={cn(CHIP, "gap-0.5 pl-1 pr-1.5 font-medium", t.cls)}>
      <Glyph className="size-3 shrink-0" strokeWidth={2.25} aria-hidden />
      {ACTION_LABEL[action] ?? action}
    </span>
  );
}

/**
 * Filing states. Round pills with a dot, in the muted status set: green ok,
 * primary in flight, attention (amber), error, grey history — the status
 * tokens, never the buy/sell pair.
 */
const OK = { cls: "bg-ok-soft text-ok", dot: "bg-ok" };
const GREY = { cls: NEUTRAL, dot: "bg-muted-foreground" };
const WARN = { cls: AMBER, dot: "bg-attention" };

const STATUS_TONE: Record<string, { label: string; cls: string; dot: string }> = {
  notified: { label: "alerted", ...OK },
  backfilled: { label: "history", ...GREY },
  parsed: { label: "sending", cls: "bg-primary/10 text-primary", dot: "bg-primary" },
  new: { label: "processing", cls: AMBER, dot: "bg-attention motion-safe:animate-pulse" },
  backfill_queued: { label: "queued", ...WARN },
  failed: {
    label: "unreadable",
    cls: "bg-error-soft text-error",
    dot: "bg-error",
  },
  seen_skipped: { label: "indexed", ...GREY },
  // A scan the grid reader has captured but no model has transcribed: the
  // filing's status is still `failed`, yet "unreadable" would be false — its
  // boxes were read, only the written text is missing.
  not_transcribed: { label: "not transcribed", ...WARN },
};

export function Pill({ tone, dot, children }: { tone: string; dot: string; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full align-middle px-2 text-[11px] font-medium leading-none",
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
 * Party as a neutral letter (or, with `full`, the word). Deliberately not
 * blue/red: that pair is the buy/sell encoding on every chart and pill, and
 * a Democrat tinted like a purchase would read as one.
 */
export function PartyBadge({ party, full = false }: { party: string | null; full?: boolean }) {
  if (!party) return null;
  const label = PARTY_LABEL[party] ?? party;
  return (
    <span
      className={cn(
        CHIP,
        HAIRLINE,
        "justify-center bg-muted font-semibold text-ink-2",
        full ? "px-1.5" : "w-5 px-0 text-[10.5px]"
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
        HAIRLINE,
        FOCUS_RING,
        "bg-[var(--card-solid)] px-1.5 font-mono text-[11.5px] font-semibold tracking-tight text-foreground",
        "transition-[background-color,box-shadow,color] duration-(--dur) ease-(--ease-out)",
        "hover:bg-accent hover:text-accent-foreground hover:ring-primary/35 active:bg-primary/15"
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
  const cls = cn(CHIP, AMBER);
  const title =
    "Read from a scanned paper filing (text by a vision model, ticked boxes by the grid reader). Counted as a trade; excluded from every volume total.";
  if (docId) {
    return (
      <Link
        href={`/scans/${encodeURIComponent(docId)}`}
        className={cn(cls, FOCUS_RING, "transition-[filter] duration-(--dur) ease-(--ease-out) hover:brightness-95 dark:hover:brightness-125")}
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

/** The error status ink: muted, and AA as text on every surface. */
const LATE_INK = "text-error";
const AS_FILED_INK = "text-attention";

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
      <span
        className={cn("whitespace-nowrap text-[11px]", AS_FILED_INK)}
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
      <span
        className={cn("whitespace-nowrap text-[11px]", AS_FILED_INK)}
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
        <span className={cn(CHIP, AMBER)} title="The filer ticked the form's own 'late' box">
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
   Controls. One segmented control, one button, one field, at two sizes
   that share a radius (8px) and a focus ring.
   ------------------------------------------------------------------ */

/** A secondary button / link-button: hairline, soft hover, pressed tint. */
export const BUTTON = cn(
  "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-control border border-border",
  "bg-[var(--card-solid)] px-3 text-xs font-medium text-muted-foreground",
  "transition-[background-color,border-color,color] duration-(--dur) ease-(--ease-out)",
  "hover:border-border-strong hover:bg-raised hover:text-foreground active:bg-secondary",
  FOCUS_RING
);
/** The one filled button in a form: its submit. */
export const BUTTON_PRIMARY = cn(
  "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-control bg-primary px-3.5",
  "text-xs font-medium text-primary-foreground shadow-[inset_0_1px_0_0_rgb(255_255_255/0.12)]",
  "transition-[filter,background-color] duration-(--dur) ease-(--ease-out) hover:brightness-110 active:brightness-95",
  FOCUS_RING
);

/** Text inputs and selects: one height, radius, hover and focus treatment. */
export const FIELD = cn(
  "h-8 w-full min-w-0 rounded-control border border-input bg-[var(--card-solid)] px-2.5 text-[13px] text-foreground",
  "transition-[border-color,box-shadow] duration-(--dur) ease-(--ease-out) dark:[color-scheme:dark]",
  // Focus keeps the base 2px ring (offset 2px); the border firms to match it.
  "hover:border-border-strong focus:border-ring",
  "placeholder:text-muted-foreground"
);

/** One option of a segmented control (see `Segmented`). */
export function segmentClass(active: boolean) {
  return cn(
    "inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-chip px-2.5 text-xs font-medium",
    "transition-[background-color,color,box-shadow] duration-(--dur) ease-(--ease-out)",
    FOCUS_RING,
    "focus-visible:outline-offset-1",
    active
      ? "bg-[var(--card-solid)] text-foreground shadow-[0_1px_2px_rgb(0_0_0/0.06)] ring-1 ring-border"
      : "text-muted-foreground hover:bg-secondary hover:text-foreground active:bg-foreground/[0.08]"
  );
}

/**
 * A segmented control of links: the state is the URL, so each option is a
 * plain `<a>` and the active one carries `aria-current`. Use it for every
 * All/Buys/Sells, window or kind switch so they look and behave as one.
 */
export function Segmented({
  label,
  items,
  className,
}: {
  /** Names the group for assistive tech ("Trade direction"). */
  label: string;
  items: { key: string; label: React.ReactNode; href: string; active: boolean; dot?: string }[];
  className?: string;
}) {
  return (
    <nav
      aria-label={label}
      className={cn("inline-flex max-w-full items-center gap-0.5 rounded-control bg-muted p-0.5 ring-1 ring-inset ring-border/60", className)}
    >
      {items.map((it) => (
        <a key={it.key} href={it.href} aria-current={it.active ? "page" : undefined} className={segmentClass(it.active)}>
          {it.dot ? <span className="size-1.5 rounded-full" style={{ background: it.dot }} aria-hidden /> : null}
          {it.label}
        </a>
      ))}
    </nav>
  );
}

export { isBuy, isSell };
