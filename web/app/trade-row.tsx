/**
 * Trade rows outside the home feed: the "Every disclosed trade" lists on a
 * member page (one member, many assets) and a ticker page (one asset, many
 * members). One card, hairline rows, the same columns as the feed so a trade
 * reads the same wherever it appears:
 *
 *   ≥640px   date | action | ticker or member | bracket + range | asset, tags | delay · filing
 *   <640px   action | ticker or member | bracket + range
 *            asset, tags                          date · delay · filing
 *
 * Also the cells the feed shares (`TickerCell`, `TradeDelay`, `AssetName`).
 */

import { filedBeforeTrade, monthDay, todayIso } from "@/lib/feed";
import { assetLabel } from "@/lib/asset-label";
import { ASSET_TYPE_LABEL, memberHref, memberLabel } from "@/lib/format";
import type { TransactionRow } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { MemberAvatar } from "./avatar";
import { BracketAmount } from "./bracket-glyph";
import { Card } from "./charts";
import { ActionBadge, DelayTag, OptionBadge, OwnerTag, PartyBadge, ScanTag, SectorTag, TickerChip } from "./ui";

/* ---------------------------------------------------------------- cells */

/**
 * An asset name as a list shows it: the filer's boilerplate trimmed by
 * `assetLabel` (display only), the name exactly as filed in the title.
 */
export function AssetName({
  name,
  ticker,
  className,
}: {
  name: string | null | undefined;
  /** The ticker the row already shows, so a repeated "(SYM)" can go. */
  ticker?: string | null;
  className?: string;
}) {
  if (!name) return null;
  return (
    <span className={cn("min-w-0 truncate text-muted-foreground", className)} title={name}>
      {assetLabel(name, { ticker }) || name}
    </span>
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

/** The ticker chip, or for a row with no ticker its asset type in short. */
export function TickerCell({ ticker, type }: { ticker: string | null; type: string | null }) {
  if (ticker) return <TickerChip ticker={ticker} type={type} />;
  const full = type ? ASSET_TYPE_LABEL[type] ?? type : "no ticker";
  return (
    <span className="text-[12px] text-muted-foreground" title={full}>
      {type ? SHORT_TYPE[type] ?? full : full}
    </span>
  );
}

/**
 * The disclosure delay, or "date as filed" when the filing is dated before
 * the trade it reports (the delay is NULL then; a negative one is never shown).
 */
export function TradeDelay({ r }: { r: Pick<TransactionRow, "tx_date" | "filing_date" | "delay_days" | "dates_inconsistent"> }) {
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

function FilingLink({ href }: { href: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="rounded-sm text-[12px] text-muted-foreground underline decoration-border underline-offset-[3px] transition-colors duration-150 hover:text-primary hover:decoration-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      filing<span aria-hidden>&nbsp;↗</span>
      <span className="sr-only"> (opens the original filing)</span>
    </a>
  );
}

/* ----------------------------------------------------------------- list */

/** The card the rows sit in. */
export function TradeList({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <Card className={cn("p-0 sm:p-0", className)}>
      <ul className="divide-y divide-border/60 px-1.5 py-1 sm:px-2">{children}</ul>
    </Card>
  );
}

/**
 * One disclosed trade. `subject` picks what the second column names: the
 * asset (a member page — every row is the same member) or the member (a
 * ticker page — every row is the same asset).
 */
export function TradeRow({ r, subject }: { r: TransactionRow; subject: "asset" | "member" }) {
  const today = todayIso();
  const traded = monthDay(r.tx_date, today);
  return (
    <li
      className={cn(
        "grid items-center gap-x-3 gap-y-1 rounded-md px-1.5 py-2 transition-colors duration-150 hover:bg-[var(--feed-hover)] focus-within:bg-[var(--feed-hover)] sm:min-h-10 sm:px-2 sm:py-1.5",
        "grid-cols-[auto_minmax(0,1fr)_auto] [grid-template-areas:'act_subj_amt'_'detail_detail_meta']",
        subject === "asset"
          ? "sm:grid-cols-[5.75rem_6.5rem_5.5rem_11rem_minmax(0,1fr)_auto]"
          : "sm:grid-cols-[5.75rem_6.5rem_minmax(0,17rem)_11rem_minmax(0,1fr)_auto]",
        "sm:[grid-template-areas:'date_act_subj_amt_detail_meta']"
      )}
    >
      <span className="tabular hidden text-[13px] text-muted-foreground [grid-area:date] sm:block" title={r.tx_date ?? undefined}>
        {traded}
      </span>
      <span className="[grid-area:act]">
        <ActionBadge action={r.action} />
      </span>
      <span className="flex min-w-0 items-center gap-2 [grid-area:subj]">
        {subject === "asset" ? (
          <>
            <TickerCell ticker={r.ticker} type={r.asset_type} />
            {/* On a phone the date rides the first line, leaving the second to the asset name. */}
            <span className="tabular truncate text-[12px] text-muted-foreground sm:hidden">{traded}</span>
          </>
        ) : (
          <>
            <MemberAvatar name={r.member_name} bioguideId={r.bioguide_id} size="sm" />
            <a
              href={memberHref(r.member_name)}
              className="min-w-0 truncate rounded-sm text-[13px] font-medium transition-colors duration-150 hover:text-primary focus-visible:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              title={memberLabel(r.member_name, r.party, r.state, r.district, r.chamber)}
            >
              {memberLabel(r.member_name, null, r.state, r.district, r.chamber)}
            </a>
            <span className="flex shrink-0">
              <PartyBadge party={r.party} />
            </span>
          </>
        )}
      </span>
      <BracketAmount
        className="justify-self-end [grid-area:amt] sm:justify-self-start"
        min={r.amount_min_cents}
        max={r.amount_max_cents}
        exact={r.amount_exact_cents}
        transcribed={r.transcribed}
      />
      <span className="flex min-w-0 items-center gap-1.5 text-[13px] [grid-area:detail]">
        {subject === "asset" ? <AssetName name={r.asset_name} ticker={r.ticker} /> : null}
        <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap empty:hidden">
          <OptionBadge kind={r.option_kind} strikeCents={r.strike_cents} expiry={r.expiry} />
          <SectorTag group={r.industry_group} sic={r.sic} description={r.sic_description} />
          <OwnerTag owner={r.owner} />
          <ScanTag transcribed={r.transcribed} docId={r.doc_id} />
        </span>
      </span>
      <span className="flex items-center justify-end gap-2 whitespace-nowrap [grid-area:meta]">
        {subject === "member" ? (
          <span className="tabular text-[12px] text-muted-foreground sm:hidden">{traded}</span>
        ) : null}
        <span className="min-w-8 text-right">
          <TradeDelay r={r} />
        </span>
        <FilingLink href={r.pdf_url} />
      </span>
    </li>
  );
}
