import type { PoliticianDetail, PoliticianTickerRow } from "@/lib/queries";
import { longDate, seatLabel, tradeSummary } from "@/lib/members";
import { MemberAvatar } from "../avatar";
import { PartyBadge, TickerChip } from "../ui";

/**
 * The top of a member's page: portrait, name, seat, party and one line of
 * plain language computed from the whole record. Nothing here is a dollar
 * figure — the stat tiles below carry the estimate, labelled as one.
 */
export function MemberHero({
  detail,
  tickers,
  scanCount,
  scansHref,
}: {
  detail: PoliticianDetail;
  /** The member's tickers (any order); the three most often traded are named. */
  tickers: PoliticianTickerRow[];
  scanCount: number;
  scansHref: string;
}) {
  const seat = seatLabel(detail.chamber, detail.state, detail.district);
  const exchanges = Math.max(detail.trades - detail.buys - detail.sells, 0);
  const top = [...tickers]
    .sort((a, b) => b.trades - a.trades || b.volume_mid - a.volume_mid)
    .slice(0, 3);
  const sameDay = detail.first_tx_date === detail.last_tx_date;

  return (
    // Open on the paper like every page head (DESIGN.md): no box, no glow.
    <section className="relative">
      <div className="relative flex items-start gap-4 sm:gap-6">
        <MemberAvatar name={detail.member_name} bioguideId={detail.bioguide_id} size="xl" />
        <div className="min-w-0 flex-1">
          <div className="kicker">
            {seat ?? (
              <span title="The filer's name as printed on the filing; it did not match the congressional roster">
                Not matched to the roster
              </span>
            )}
          </div>
          <h1 className="display mt-1.5 text-[34px] leading-[1.06] sm:text-[46px] sm:leading-[1.04]">
            {detail.member_name}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[13px] text-muted-foreground">
            <PartyBadge party={detail.party} full />
            <span>
              {sameDay
                ? `traded ${longDate(detail.first_tx_date)}`
                : `trades dated ${longDate(detail.first_tx_date)} – ${longDate(detail.last_tx_date)}`}
            </span>
          </div>
          <p className="dek mt-3 text-[17px] leading-snug sm:text-[19px]">
            {tradeSummary(detail)}
            <span className="text-muted-foreground">
              {" "}
              in {detail.filings} filing{detail.filings === 1 ? "" : "s"}.
            </span>
          </p>
        </div>
      </div>

      <div className="relative mt-5 grid gap-4 border-t border-border/70 pt-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-8">
        <DirectionSplit buys={detail.buys} sells={detail.sells} exchanges={exchanges} />
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[12px] text-muted-foreground">
          {top.length ? (
            <span className="inline-flex flex-wrap items-center gap-1.5">
              <span>Most traded</span>
              {top.map((t) => (
                <TickerChip key={t.ticker} ticker={t.ticker} />
              ))}
            </span>
          ) : null}
          {detail.bioguide_id ? (
            <a
              href={`https://bioguide.congress.gov/search/bio/${detail.bioguide_id}`}
              target="_blank"
              rel="noreferrer"
              className="underline-offset-2 hover:text-primary hover:underline"
            >
              bioguide ↗
            </a>
          ) : null}
          {scanCount ? (
            <a
              href={scansHref}
              className="underline-offset-2 hover:text-primary hover:underline"
              title="Paper filings scanned without a text layer; inspect what the grid reader saw"
            >
              {scanCount} scanned filing{scanCount === 1 ? "" : "s"}
            </a>
          ) : null}
        </div>
      </div>
    </section>
  );
}

/**
 * Share of the member's trades by direction, as a single thin bar. The
 * diverging buy/sell pair is used because this *is* direction, and the
 * counts are written beside it so colour never carries the meaning alone.
 * Exchanges are neither and are counted in words only.
 */
function DirectionSplit({ buys, sells, exchanges }: { buys: number; sells: number; exchanges: number }) {
  const total = buys + sells;
  if (!total) {
    return <div className="text-[12px] text-muted-foreground">No buys or sells — exchanges only</div>;
  }
  const buyPct = (buys / total) * 100;
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-3 text-[12px]">
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2 rounded-full" style={{ background: "var(--viz-buy)" }} />
          <span className="tabular font-medium text-foreground">{buys}</span>
          <span className="text-muted-foreground">bought</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="text-muted-foreground">sold</span>
          <span className="tabular font-medium text-foreground">{sells}</span>
          <span className="size-2 rounded-full" style={{ background: "var(--viz-sell)" }} />
        </span>
      </div>
      <div
        className="mt-1.5 flex h-2 gap-0.5 overflow-hidden rounded-full"
        role="img"
        aria-label={`${buys} buys and ${sells} sells`}
      >
        {buys ? <div style={{ width: `${buyPct}%`, background: "var(--viz-buy)" }} /> : null}
        {sells ? <div className="flex-1" style={{ background: "var(--viz-sell)" }} /> : null}
      </div>
      {exchanges ? (
        <div className="mt-1 text-[11px] text-muted-foreground">
          + {exchanges} exchange{exchanges === 1 ? "" : "s"}, neither direction
        </div>
      ) : null}
    </div>
  );
}
