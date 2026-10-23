import { ArrowUpRight } from "lucide-react";
import type { PoliticianDetail, PoliticianTickerRow } from "@/lib/queries";
import { PARTY_LABEL, longDate, seatLabel, tradeSummary } from "@/lib/members";
import { cn } from "@/lib/utils";
import { MemberAvatar } from "../avatar";
import { BUTTON, TickerChip } from "../ui";

/**
 * The top of a member's page, set like an iOS contact card: a round
 * portrait, the name large and bold, chamber · seat · party in grey, one
 * line of plain language computed from the whole record, then the card's
 * actions as capsules. Nothing here is a dollar figure — the stat tiles
 * below carry the estimate, labelled as one.
 */
export function MemberHero({
  detail,
  scanCount,
  scansHref,
  share,
}: {
  detail: PoliticianDetail;
  scanCount: number;
  scansHref: string;
  /** The page's ShareControl, set among the card's actions. */
  share?: React.ReactNode;
}) {
  const seat = seatLabel(detail.chamber, detail.state, detail.district);
  const party = detail.party ? PARTY_LABEL[detail.party] ?? detail.party : null;
  const sameDay = detail.first_tx_date === detail.last_tx_date;

  return (
    <section className="flex flex-col items-center text-center">
      <MemberAvatar name={detail.member_name} bioguideId={detail.bioguide_id} size="xl" />
      <h1 className="display mt-4 max-w-full break-words text-[32px] leading-[1.1] sm:mt-5 sm:text-[44px] sm:leading-[1.05]">
        {detail.member_name}
      </h1>
      <p className="mt-1.5 text-[17px] leading-snug text-muted-foreground sm:text-[19px]">
        {seat ? (
          [seat, party].filter(Boolean).join(" · ")
        ) : (
          <span title="The filer's name as printed on the filing; it did not match the congressional roster">
            Not matched to the roster{party ? ` · ${party}` : ""}
          </span>
        )}
      </p>
      <p className="mt-3 max-w-[46ch] text-[15px] leading-normal text-ink-2 first-letter:uppercase sm:text-[16px]">
        {tradeSummary(detail)}.
      </p>
      <p className="tabular mt-0.5 text-[13px] text-muted-foreground sm:text-[14px]">
        {detail.filings} filing{detail.filings === 1 ? "" : "s"} ·{" "}
        {sameDay
          ? `traded ${longDate(detail.first_tx_date)}`
          : `traded ${longDate(detail.first_tx_date)} – ${longDate(detail.last_tx_date)}`}
      </p>
      <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
        {share}
        {detail.bioguide_id ? (
          <a
            href={`https://bioguide.congress.gov/search/bio/${detail.bioguide_id}`}
            target="_blank"
            rel="noreferrer"
            className={BUTTON}
          >
            Congress bio
            <ArrowUpRight className="size-3.5 opacity-60" strokeWidth={2.25} aria-hidden />
          </a>
        ) : null}
        {scanCount ? (
          <a
            href={scansHref}
            className={BUTTON}
            title="Paper filings scanned without a text layer; inspect what the grid reader saw"
          >
            {scanCount} scanned filing{scanCount === 1 ? "" : "s"}
          </a>
        ) : null}
      </div>
    </section>
  );
}

/**
 * Direction at a glance, in one tile: the share of buys and sells as one
 * thin bar with both counts written beside it, and the three tickers the
 * member trades most often.
 */
export function MemberGlance({
  detail,
  tickers,
  className,
}: {
  detail: PoliticianDetail;
  /** The member's tickers (any order); the three most often traded are named. */
  tickers: PoliticianTickerRow[];
  className?: string;
}) {
  const exchanges = Math.max(detail.trades - detail.buys - detail.sells, 0);
  const top = [...tickers]
    .sort((a, b) => b.trades - a.trades || b.volume_mid - a.volume_mid)
    .slice(0, 3);
  return (
    <GlanceTile
      className={className}
      aside={
        top.length ? (
          <>
            <span className="mr-1 font-semibold">Most traded</span>
            {top.map((t) => (
              <TickerChip key={t.ticker} ticker={t.ticker} />
            ))}
          </>
        ) : null
      }
    >
      <DirectionSplit buys={detail.buys} sells={detail.sells} exchanges={exchanges} />
    </GlanceTile>
  );
}

/**
 * The glance tile shared by the member, ticker and issuer pages: a
 * `DirectionSplit` on the left and a short "most ..." line on the right
 * (under it on a phone).
 */
export function GlanceTile({
  children,
  aside,
  className,
}: {
  children: React.ReactNode;
  aside?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "tile grid gap-x-10 gap-y-4 p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:px-6 sm:py-5",
        className
      )}
    >
      {children}
      {aside ? (
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-2 text-[13px] text-muted-foreground sm:max-w-[28rem] sm:justify-end">
          {aside}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Share of trades by direction, as a single thin bar. The diverging buy/sell
 * pair is used because this *is* direction, and the counts are written
 * beside it so colour never carries the meaning alone. Exchanges are neither
 * and are counted in words only. `buyers`/`sellers` add who did it ("by 4
 * members") under each end.
 */
export function DirectionSplit({
  buys,
  sells,
  exchanges = 0,
  buyers,
  sellers,
  noun = "member",
}: {
  buys: number;
  sells: number;
  exchanges?: number;
  buyers?: number;
  sellers?: number;
  /** What `buyers`/`sellers` count. */
  noun?: string;
}) {
  const total = buys + sells;
  if (!total) {
    return <div className="text-[13px] text-muted-foreground">No buys or sells — exchanges only</div>;
  }
  const buyPct = (buys / total) * 100;
  const by = (n: number | undefined) => (n == null ? "" : `by ${n} ${noun}${n === 1 ? "" : "s"}`);
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-3 text-[13px]">
        <span className="inline-flex items-baseline gap-1.5">
          <span aria-hidden className="size-2 self-center rounded-full" style={{ background: "var(--viz-buy)" }} />
          <span className="figure text-[22px] leading-none text-foreground">{buys}</span>
          <span className="text-muted-foreground">bought</span>
        </span>
        <span className="inline-flex items-baseline gap-1.5">
          <span className="text-muted-foreground">sold</span>
          <span className="figure text-[22px] leading-none text-foreground">{sells}</span>
          <span aria-hidden className="size-2 self-center rounded-full" style={{ background: "var(--viz-sell)" }} />
        </span>
      </div>
      <div
        className="mt-2.5 flex h-2 gap-[3px]"
        role="img"
        aria-label={[`${buys} buys`, by(buyers), "and", `${sells} sells`, by(sellers)].filter(Boolean).join(" ")}
      >
        {buys ? <div className="rounded-full" style={{ width: `${buyPct}%`, background: "var(--viz-buy)" }} /> : null}
        {sells ? <div className="flex-1 rounded-full" style={{ background: "var(--viz-sell)" }} /> : null}
      </div>
      {buyers != null || sellers != null ? (
        <div className="tabular mt-1.5 flex justify-between gap-3 text-[12px] text-muted-foreground">
          <span>{buys ? by(buyers) : null}</span>
          <span>{sells ? by(sellers) : null}</span>
        </div>
      ) : null}
      {exchanges ? (
        <div className="mt-1.5 text-[12px] text-muted-foreground">
          + {exchanges} exchange{exchanges === 1 ? "" : "s"}, neither direction
        </div>
      ) : null}
    </div>
  );
}
