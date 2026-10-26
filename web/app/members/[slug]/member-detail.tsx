import { getPoliticianCommittees, getPoliticianSectors, getPoliticianTickers, getTransactions, type CommitteeSeatRow, type PoliticianDetail } from "@/lib/queries";
import { getScanFilings } from "@/lib/scan-queries";
import { MemberTimeline } from "../../timeline";
import { committeeHref, memberHref, range, tickerHref, usd } from "@/lib/format";
import { Card, DivergingSplit, Empty, MagnitudeBars, SectionTitle, StatTile, VOLUME_NOTE, VolumeRange } from "../../charts";
import { ExportLink } from "../../feed-controls";

import { TradeList, TradeRow } from "../../trade-row";
import { MemberGlance, MemberHero } from "../../politicians/member-hero";
import { AgentAlternates } from "../../agent-alternates";
import { assetLabel } from "@/lib/asset-label";
import { Disclosure, RangeCaption } from "../../disclosure";
import { BackLink, DataError, PAGE_STACK, Quiet } from "../../page-header";
import { ShareControl } from "../../share-control";
import { FollowButton, GetAlertsPopover } from "../../watchlist-client";
import { absoluteUrl } from "@/lib/site";
import { Segmented } from "../../ui";
import { MemberTrack } from "./member-track";

/*
 * One member's page, `/members/<slug>`. Moved out of app/politicians/page.tsx
 * when the member view got its own URL; the committee roster there still
 * uses `SeatTag` from here.
 */

/**
 * Trades rendered on one member's page. The stat tiles above the list are
 * aggregated over every trade, so a member with more than this many still
 * reads correctly; the list says how many it is showing.
 */
const TRADE_PAGE = 300;
const FILTERS = [
  { k: undefined, label: "All" },
  { k: "buy", label: "Buys" },
  { k: "sell", label: "Sells" },
];

/** The page body for a member with counted trades; the route resolves the
 *  slug and fetches `detail` first, since its metadata needs the same row. */
export async function MemberDetail({
  detail,
  action,
}: {
  detail: PoliticianDetail;
  action?: string;
}) {
  const member = detail.member_name;
  const bioguideId = detail.bioguide_id;
  let tickers, trades, scans, sectors, committees;
  try {
    [tickers, trades, scans, sectors, committees] = await Promise.all([
      getPoliticianTickers(member, 40),
      getTransactions({ member, action, limit: TRADE_PAGE }),
      getScanFilings({ member }),
      getPoliticianSectors(member),
      getPoliticianCommittees(member),
    ]);
  } catch (err) {
    return <DataError error={err} />;
  }

  const byTrades = [...tickers].sort((a, b) => b.trades - a.trades || b.volume_mid - a.volume_mid);
  const scaleMax = detail.volume_max ?? detail.volume_min * 2;
  // Count of trades the active filter covers — from the aggregate, not the
  // rendered slice, so "showing 300 of 883" is honest.
  const matching = action === "buy" ? detail.buys : action === "sell" ? detail.sells : detail.trades;

  // Paper filings print no symbol, so a member read only from scans has
  // trades and no tickers; "0 tickers" would read as a data fault.
  const tickersUnprinted = detail.tickers === 0 && detail.transcribed > 0;

  return (
    <div className={PAGE_STACK}>
      <AgentAlternates member={bioguideId} />
      <header className="space-y-8 sm:space-y-10">
        <div className="mb-3 flex items-center justify-between sm:mb-4">
          <BackLink href="/politicians" label="Members" />
        </div>
        <MemberHero
          detail={detail}
          scanCount={scans.length}
          scansHref={`/scans?m=${encodeURIComponent(member)}`}
          share={
            <>
              {bioguideId ? (
                <>
                  <FollowButton kind="member" id={bioguideId} label={member} />
                  <GetAlertsPopover subject={{ kind: "member", id: bioguideId, label: member }} />
                </>
              ) : null}
              <ShareControl
                url={absoluteUrl(memberHref(member, bioguideId))}
                text={`${member}${detail.party && detail.state ? ` (${detail.party}-${detail.state})` : ""}: disclosed stock trades from STOCK Act filings`}
              />
            </>
          }
        />
        <div className="space-y-3 sm:space-y-4">
          <section aria-label="Totals" className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
            <StatTile
              label="Trades"
              value={String(detail.trades)}
              hint={`${detail.buys} buy / ${detail.sells} sell`}
            />
            <StatTile
              label="Tickers"
              value={tickersUnprinted ? "—" : String(detail.tickers)}
              hint={
                tickersUnprinted
                  ? "tickers not printed on paper filings"
                  : `across ${detail.filings} filing${detail.filings === 1 ? "" : "s"}`
              }
            />
            <StatTile
              label="Volume (est.)"
              value={usd(detail.volume_mid)}
              hint={
                detail.transcribed
                  ? `bracket midpoints · ${detail.transcribed} transcribed row${detail.transcribed === 1 ? "" : "s"} not counted`
                  : "bracket midpoints"
              }
            />
            <StatTile
              label="Late disclosures"
              value={String(detail.late_count)}
              hint={
                detail.avg_delay == null ? "past 45 days" : `mean delay ${Math.round(detail.avg_delay)}d`
              }
            />
          </section>
          <MemberGlance detail={detail} tickers={tickers} />
        </div>
      </header>

      <MemberTimeline member={member} />

      <section>
        <SectionTitle kicker="Bracket Interval">Disclosed volume range</SectionTitle>
        <Card>
          <VolumeRange
            min={detail.volume_min}
            max={detail.volume_max}
            mid={detail.volume_mid}
            scaleMax={scaleMax}
          />
          <RangeCaption />
        </Card>
      </section>

      <MemberTrack member={member} />

      {committees.length ? <MemberCommittees seats={committees} /> : null}

      <section className="grid gap-8 lg:grid-cols-2 lg:gap-4">
        <div className="flex flex-col [&>:last-child]:flex-1">
          <SectionTitle kicker="Top Symbols">Most traded by volume</SectionTitle>
          <Card>
            <MagnitudeBars
              data={tickers.slice(0, 12).map((r) => ({
                key: r.ticker,
                label: r.ticker,
                sublabel: assetLabel(r.asset_name, { ticker: r.ticker }).slice(0, 28) || undefined,
                title: r.asset_name ?? undefined,
                value: r.volume_mid,
                valueLabel: usd(r.volume_mid),
                detail: `disclosed ${range(r.volume_min, r.volume_max)}`,
                href: tickerHref(r.ticker),
              }))}
              note={VOLUME_NOTE}
            />
            <p className="mt-4 text-[13px] leading-relaxed text-muted-foreground">
              Estimated from disclosure brackets. Assets without a ticker — Treasuries,
              funds — appear in the trade list below.
            </p>
          </Card>
        </div>
        <div className="flex flex-col [&>:last-child]:flex-1">
          <SectionTitle kicker="Direction Split">Buy / sell by ticker</SectionTitle>
          <Card>
            <DivergingSplit
              unit="trades, by direction"
              data={byTrades.slice(0, 12).map((r) => ({
                key: r.ticker,
                label: r.ticker,
                sublabel: `${r.trades} trade${r.trades === 1 ? "" : "s"}`,
                buy: r.buys,
                sell: r.sells,
                href: tickerHref(r.ticker),
              }))}
            />
          </Card>
        </div>
      </section>

      <section>
        <SectionTitle
          kicker="Complete Ledger"
          right={
            <div className="flex items-center gap-2">
              <Segmented
                label="Trade direction"
                items={FILTERS.map((f) => ({
                  key: f.label,
                  label: f.label,
                  href: memberHref(member, bioguideId, f.k),
                  active: (action ?? undefined) === f.k,
                }))}
              />
              <ExportLink
                filters={{ member, action: action === "buy" || action === "sell" ? action : undefined }}
              />
            </div>
          }
        >
          Every disclosed trade
        </SectionTitle>

        {trades.length ? (
          <>
            <p className="mb-3 pl-1 text-[13px] text-muted-foreground">
              {trades.length < matching
                ? `Newest ${trades.length} of ${matching} trades`
                : `${trades.length} trades, newest first`}
            </p>
            <TradeList>
              {trades.map((r) => (
                <TradeRow key={r.id} r={r} subject="asset" />
              ))}
            </TradeList>
          </>
        ) : (
          <Empty>No trades match this filter.</Empty>
        )}
      </section>

      <MemberSectors sectors={sectors} trades={detail.trades} />
    </div>
  );
}

/**
 * Trades by industry group (#55): every trade of the member, counted and
 * with the range its brackets disclose. The unclassified remainder is a row
 * of its own, so the groups always add up to the member's trade count.
 */
function MemberSectors({
  sectors,
  trades,
}: {
  sectors: Awaited<ReturnType<typeof getPoliticianSectors>>;
  trades: number;
}) {
  const classified = sectors.filter((s) => s.industry_group);
  const unclassified = sectors.find((s) => !s.industry_group);
  return (
    <section>
      <SectionTitle
        kicker="Industry Exposure"
        right={<span className="text-muted-foreground">Trade count · disclosed range</span>}
      >
        By sector
      </SectionTitle>
      <Card>
        {classified.length ? (
          <MagnitudeBars
            variant="name"
            data={[...classified, ...(unclassified ? [unclassified] : [])].map((s) => ({
              key: s.industry_group ?? "unclassified",
              label: s.industry_group ?? "Unclassified",
              sublabel: `${
                s.trades > s.transcribed ? range(s.volume_min, s.volume_max) : "no counted amount"
              } · ${s.buys} buy / ${s.sells} sell`,
              value: s.trades,
              valueLabel: `${s.trades} trade${s.trades === 1 ? "" : "s"}`,
            }))}
          />
        ) : (
          <Quiet>
            No sector is known for this member&rsquo;s trades yet. The pipeline classifies
            issuers from their EDGAR SIC codes after each run.
          </Quiet>
        )}
        <Disclosure
          size="sm"
          className="mt-3"
          lead="The range is what the brackets in that sector disclose; a group with an open-ended bracket shows a floor only."
        >
          <p>
            Industry groups fold EDGAR&rsquo;s SIC code for each issuer into twelve sectors.
            {unclassified
              ? ` ${unclassified.trades} of ${trades} trades are unclassified: assets with no ticker (Treasuries, funds), ETF trusts and other issuers EDGAR lists no SIC for, or symbols the fill has not reached yet.`
              : " Every trade here carries a sector."}
          </p>
        </Disclosure>
      </Card>
    </section>
  );
}

/* ------------------------------------------------------------- committees */

export const CHAMBER_LABEL: Record<string, string> = { house: "House", senate: "Senate", joint: "Joint" };

/** How a seat is held: leadership title, side and seniority as the source lists them. */
export function SeatTag({
  seat,
}: {
  seat: Pick<CommitteeSeatRow, "rank" | "side" | "title" | "seat_chamber">;
}) {
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-muted-foreground">
      {seat.title ? (
        <span className="rounded-md bg-fill px-1.5 py-px text-[11px] font-medium text-ink-2">
          {seat.title}
        </span>
      ) : null}
      {seat.side ? (
        <span>
          {seat.side}
          {seat.rank != null ? ` · rank ${seat.rank}` : ""}
        </span>
      ) : null}
      {seat.seat_chamber ? <span>· for the {CHAMBER_LABEL[seat.seat_chamber] ?? seat.seat_chamber}</span> : null}
    </span>
  );
}

/**
 * The member's seats in the current Congress: each full committee with the
 * subcommittees under it the member also sits on. A subcommittee seat whose
 * parent the member is not listed on (some ex officio seats) still shows
 * under the parent's name, so nothing the source has is dropped.
 */
function MemberCommittees({ seats }: { seats: CommitteeSeatRow[] }) {
  const groups = new Map<
    string,
    { id: string; name: string; seat: CommitteeSeatRow | null; subs: CommitteeSeatRow[] }
  >();
  for (const s of seats) {
    const key = s.parent_id ?? s.thomas_id;
    const g = groups.get(key) ?? { id: key, name: s.parent_name ?? s.name, seat: null, subs: [] };
    if (s.parent_id) g.subs.push(s);
    else g.seat = s;
    groups.set(key, g);
  }
  return (
    <section>
      <SectionTitle
        kicker="Legislative Assignments"
        right={
          <span className="text-muted-foreground">
            Current Congress · {groups.size} committee{groups.size === 1 ? "" : "s"}
          </span>
        }
      >
        Committees
      </SectionTitle>
      <Card className="p-0 sm:p-0">
        <ul className="inset-rows py-1">
          {[...groups.values()].map((g) => (
            <li key={g.id} className="px-4 py-3 sm:px-5">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[14px]">
                <a href={committeeHref(g.id)} className="font-semibold decoration-border-strong underline-offset-[3px] hover:underline">
                  {g.name}
                </a>
                {g.seat ? <SeatTag seat={g.seat} /> : null}
              </div>
              {g.subs.length ? (
                <ul className="mt-1.5 space-y-1 pl-4 text-[13px]">
                  {g.subs.map((s) => (
                    <li key={s.thomas_id} className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
                      <a
                        href={committeeHref(s.thomas_id)}
                        className="text-ink-2 decoration-border-strong underline-offset-[3px] hover:underline"
                      >
                        {s.name}
                      </a>
                      <SeatTag seat={s} />
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      </Card>
    </section>
  );
}

