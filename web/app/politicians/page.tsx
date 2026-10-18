import { Fragment } from "react";
import { assetLabel } from "@/lib/asset-label";
import {
  STOCK_ACT_DEADLINE_DAYS,
  getCommittee,
  getCommitteeMembers,
  getLateFilings,
  getLateMembers,
  getLateMonthly,
  getLateTotals,
  getPoliticianCommittees,
  getPoliticianDetail,
  getPoliticianSectors,
  getPoliticianTickers,
  getPoliticianTotals,
  getPoliticians,
  getSubcommittees,
  getTransactions,
  type CommitteeSeatRow,
} from "@/lib/queries";
import { getScanFilings } from "@/lib/scan-queries";
import { MemberTimeline } from "../timeline";
import { committeeHref, memberHref, range, shortDate, usd } from "@/lib/format";
import {
  Card,
  ColumnSeries,
  DivergingSplit,
  Empty,
  MagnitudeBars,
  SectionTitle,
  StatTile,
  VOLUME_NOTE,
  VolumeRange,
} from "../charts";
import { ExportLink } from "../feed-controls";
import { ActionBadge, Amount, DelayTag, OwnerTag, PartyBadge, ResponsiveTable, ScanTag, Segmented, TickerChip } from "../ui";
import { AssetName, TradeList, TradeRow } from "../trade-row";
import { MemberAvatar } from "../avatar";
import { Disclosure, RangeCaption } from "../disclosure";
import { DataError, PAGE_STACK, PageHeader, Quiet } from "../page-header";
import { MemberBars } from "./member-bars";
import { MemberHero } from "./member-hero";
import { AgentAlternates } from "../agent-alternates";
import { POLITICIAN_SORT, isDefaultSort, parseSort, type PoliticianSortKey } from "@/lib/table-sort";
import { BODY_ROW, BarCell, DATA_TABLE, HEAD_ROW, LateCell, SortHeader, SplitCell, sortHref } from "../sortable-table";
import { RowLinkBody, StickyThead } from "../table-client";

export const dynamic = "force-dynamic";

/** Every member, not a top slice: "All members" is the whole roster that has traded. */
const MEMBER_LIMIT = 2000;

// Header tooltips, in the words of the footnote under the table.
const BUYSELL_HINT = "Purchases / sales. Sorts by the share that are purchases; exchanges count as neither.";
const VOLUME_HINT =
  "Sum of disclosed bracket midpoints — an estimate, not a reported figure. An open-ended top bracket counts at its floor.";
const DELAY_HINT = "Mean days from the trade to the date the report reached the Clerk.";
const LATE_HINT =
  "Trades filed more than 45 days after the trade — the STOCK Act's deadline. A reporting fact, not an allegation of wrongdoing.";
const LAG_HINT =
  "Mean days until the member learned of the trade. A nonzero lag means someone else placed it — a spouse, a trust or a managed account — and carries no compliance meaning.";

/**
 * Trades rendered on one member's page. The stat tiles above the list are
 * aggregated over every trade, so a member with more than this many still
 * reads correctly; the list says how many it is showing.
 */
const TRADE_PAGE = 300;

export default async function PoliticiansPage({
  searchParams,
}: {
  searchParams: Promise<{ m?: string; action?: string; committee?: string; view?: string; sort?: string; dir?: string }>;
}) {
  const params = await searchParams;
  // Keyed so list -> detail (a search-param change) remounts instead of
  // morphing the list DOM; the direction filter stays inside one member.
  if (params.m)
    return (
      <Fragment key={`m:${params.m}`}>
        <MemberDetail member={params.m} action={params.action} />
      </Fragment>
    );
  if (params.view === "late")
    return (
      <Fragment key="late">
        <LateView />
      </Fragment>
    );
  if (params.committee)
    return (
      <Fragment key={`c:${params.committee}`}>
        <CommitteeView id={params.committee} />
      </Fragment>
    );

  const sort = parseSort(POLITICIAN_SORT, params);
  const standing = isDefaultSort(POLITICIAN_SORT, sort);
  let rows, totals, table;
  try {
    // The charts always rank by their own measure; the table follows the
    // URL's sort, applied in SQL over every member.
    [rows, totals, table] = await Promise.all([
      getPoliticians(undefined, MEMBER_LIMIT),
      getPoliticianTotals(),
      standing ? null : getPoliticians(undefined, MEMBER_LIMIT, sort),
    ]);
  } catch (err) {
    return <DataError error={err} />;
  }
  if (!rows.length) return <Empty>No transactions yet.</Empty>;
  table ??= rows;

  const byTrades = [...rows].sort((a, b) => b.trades - a.trades);
  const maxVolume = Math.max(0, ...rows.map((r) => r.volume_mid));
  const maxTrades = Math.max(0, ...rows.map((r) => r.trades));
  const header = (column: PoliticianSortKey, label: string, opts: { align?: "left" | "right"; hint?: string } = {}) => (
    <SortHeader
      spec={POLITICIAN_SORT}
      sort={sort}
      column={column}
      href={sortHref(POLITICIAN_SORT, sort, column, { path: "/politicians", hash: "all-members" })}
      align={opts.align}
      hint={opts.hint}
    >
      {label}
    </SortHeader>
  );

  return (
    <div className={PAGE_STACK}>
      <PageHeader
        title="Members of Congress"
        subtitle="Every member with a disclosed trade, by estimated volume and by number of trades. Amounts are disclosed brackets, so every volume here is an estimate."
      >
      <section aria-label="All members" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Members" value={String(totals.members)} hint="with disclosed trades" />
        <StatTile label="Total volume" value={usd(totals.volume_mid)} hint="estimated" />
        <a href="/politicians?view=late" className="block" title="Ranked late-filing view">
          <StatTile
            label="Late disclosures"
            value={String(totals.late_trades)}
            hint="past 45 days · ranked view →"
          />
        </a>
        <a href="/politicians?view=late" className="block" title="Ranked late-filing view">
          <StatTile
            label="Members late"
            value={String(totals.members_late)}
            hint="at least once · ranked view →"
          />
        </a>
      </section>
      </PageHeader>

      <section className="grid gap-6 lg:grid-cols-2">
        <div>
          <SectionTitle>By estimated volume</SectionTitle>
          <Card>
            <MemberBars
              data={rows.slice(0, 12).map((r) => ({
                key: r.member_name,
                name: r.member_name,
                bioguideId: r.bioguide_id,
                sublabel: `${r.party ?? "?"}-${r.state ?? "?"} · ${r.trades} trade${r.trades === 1 ? "" : "s"}`,
                value: r.volume_mid,
                valueLabel: usd(r.volume_mid),
                detail:
                  r.volume_min != null
                    ? `disclosed ${range(r.volume_min, r.volume_max ?? null)}`
                    : undefined,
                href: memberHref(r.member_name),
              }))}
              note={VOLUME_NOTE}
            />
          </Card>
        </div>
        <div>
          <SectionTitle>By number of trades</SectionTitle>
          <Card>
            <MemberBars
              data={byTrades.slice(0, 12).map((r) => ({
                key: r.member_name,
                name: r.member_name,
                bioguideId: r.bioguide_id,
                // A scan-only member has trades but no symbol: paper forms do not print one.
                sublabel:
                  r.tickers === 0 && r.transcribed > 0
                    ? "tickers not printed on paper filings"
                    : `${r.tickers} distinct ticker${r.tickers === 1 ? "" : "s"}`,
                value: r.trades,
                valueLabel: String(r.trades),
                href: memberHref(r.member_name),
              }))}
            />
          </Card>
        </div>
      </section>

      <section id="all-members" className="table-anchor">
        <SectionTitle
          right={
            <span className="text-[11px] text-muted-foreground">
              {table.length} members · sort by any column
            </span>
          }
        >
          All members
        </SectionTitle>
        <ResponsiveTable>
          <table className={DATA_TABLE}>
            <StickyThead>
              <tr className={HEAD_ROW}>
                {header("member", "Member", { align: "left" })}
                {header("trades", "Trades")}
                {header("tickers", "Tickers")}
                {header("buysell", "Buy / sell", { hint: BUYSELL_HINT })}
                {header("volume", "Volume (est.)", { hint: VOLUME_HINT })}
                {header("delay", "Delay", { hint: DELAY_HINT })}
                {header("late", "Late", { hint: LATE_HINT })}
                {header("lag", "Notify lag", { hint: LAG_HINT })}
              </tr>
            </StickyThead>
            <RowLinkBody>
              {table.map((r) => (
                <tr key={r.member_name} className={BODY_ROW} data-href={memberHref(r.member_name)}>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <MemberAvatar name={r.member_name} bioguideId={r.bioguide_id} size="sm" />
                      <a href={memberHref(r.member_name)} className="row-name font-medium hover:text-primary">
                        {r.member_name}
                      </a>
                      <PartyBadge party={r.party} />
                      <span className="text-[11px] text-muted-foreground">
                        {r.state}
                        {r.district && r.district !== "0" ? r.district : ""}
                      </span>
                    </div>
                  </td>
                  <BarCell value={r.trades} max={maxTrades}>
                    {r.trades}
                  </BarCell>
                  <td className="tabular px-3 py-2 text-right text-muted-foreground">{r.tickers}</td>
                  <SplitCell buys={r.buys} sells={r.sells} />
                  <BarCell
                    value={r.volume_mid}
                    max={maxVolume}
                    className={r.transcribed && !r.volume_mid ? "text-muted-foreground" : undefined}
                    title={
                      r.transcribed
                        ? `${r.transcribed} trade${r.transcribed === 1 ? "" : "s"} transcribed from scanned filings, not counted in this estimate`
                        : undefined
                    }
                  >
                    {usd(r.volume_mid)}
                  </BarCell>
                  <td className="tabular px-3 py-2 text-right text-muted-foreground">
                    {r.avg_delay == null ? "—" : `${Math.round(r.avg_delay)}d`}
                  </td>
                  <LateCell count={r.late_count} of={r.trades} />
                  <td className="tabular px-3 py-2 text-right text-muted-foreground">
                    {r.avg_lag == null ? "—" : `${Math.round(r.avg_lag)}d`}
                  </td>
                </tr>
              ))}
            </RowLinkBody>
          </table>
        </ResponsiveTable>
        <Disclosure
          size="sm"
          className="mt-3"
          lead={
            <>
              &ldquo;Delay&rdquo; is measured from the trade to the date the report reached the Clerk, and
              &ldquo;Late&rdquo; counts trades filed more than 45 days after the trade — the STOCK Act&rsquo;s
              deadline.
            </>
          }
        >
          <p>A late count is a reporting fact, not an allegation of wrongdoing.</p>
          <p>
            &ldquo;Notify lag&rdquo; is a different measure: how long until the member learned of the trade. A
            nonzero lag means someone else placed it — a spouse, a trust or a managed account — and carries no
            compliance meaning.
          </p>
        </Disclosure>
      </section>
    </div>
  );
}

const FILTERS = [
  { k: undefined, label: "All" },
  { k: "buy", label: "Buys" },
  { k: "sell", label: "Sells" },
];

async function MemberDetail({ member, action }: { member: string; action?: string }) {
  let detail, tickers, trades, scans, sectors, committees;
  try {
    [detail, tickers, trades, scans, sectors, committees] = await Promise.all([
      getPoliticianDetail(member),
      getPoliticianTickers(member, 40),
      getTransactions({ member, action, limit: TRADE_PAGE }),
      getScanFilings({ member }),
      getPoliticianSectors(member),
      getPoliticianCommittees(member),
    ]);
  } catch (err) {
    return <DataError error={err} />;
  }
  if (!detail) {
    return (
      <Empty>
        No disclosed trades for {member}.{" "}
        <a href="/politicians" className="underline underline-offset-2 hover:text-primary">
          All members
        </a>
      </Empty>
    );
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
      <AgentAlternates member={detail.bioguide_id} />
      <header className="space-y-5">
        <div className="space-y-2">
          <a
            href="/politicians"
            className="inline-flex rounded-md text-xs text-muted-foreground transition-colors duration-150 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            ← all members
          </a>
          <MemberHero
            detail={detail}
            tickers={tickers}
            scanCount={scans.length}
            scansHref={`/scans?m=${encodeURIComponent(member)}`}
          />
        </div>
      <section aria-label="Totals" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
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
      </header>

      <MemberTimeline member={member} />

      <section>
        <SectionTitle>Disclosed volume range</SectionTitle>
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

      {committees.length ? <MemberCommittees seats={committees} /> : null}

      <section className="grid gap-6 lg:grid-cols-2">
        <div>
          <SectionTitle>Most traded by volume</SectionTitle>
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
                href: `/tickers?t=${encodeURIComponent(r.ticker)}`,
              }))}
              note={VOLUME_NOTE}
            />
            <p className="mt-3 text-xs text-muted-foreground">
              Estimated from disclosure brackets. Assets without a ticker — Treasuries,
              funds — appear in the trade list below.
            </p>
          </Card>
        </div>
        <div>
          <SectionTitle>Buy / sell by ticker</SectionTitle>
          <Card>
            <DivergingSplit
              unit="trades, by direction"
              data={byTrades.slice(0, 12).map((r) => ({
                key: r.ticker,
                label: r.ticker,
                sublabel: `${r.trades} trades`,
                buy: r.buys,
                sell: r.sells,
                href: `/tickers?t=${encodeURIComponent(r.ticker)}`,
              }))}
            />
          </Card>
        </div>
      </section>

      <section>
        <SectionTitle
          right={
            <div className="flex items-center gap-2">
              <Segmented
                label="Trade direction"
                items={FILTERS.map((f) => ({
                  key: f.label,
                  label: f.label,
                  href: memberHref(member, f.k),
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
            <p className="mb-3 text-xs text-muted-foreground">
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
        right={<span className="text-[11px] text-muted-foreground">trade count · disclosed range</span>}
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

const CHAMBER_LABEL: Record<string, string> = { house: "House", senate: "Senate", joint: "Joint" };

/** How a seat is held: leadership title, side and seniority as the source lists them. */
function SeatTag({
  seat,
}: {
  seat: Pick<CommitteeSeatRow, "rank" | "side" | "title" | "seat_chamber">;
}) {
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-muted-foreground">
      {seat.title ? (
        <span className="rounded bg-muted px-1.5 py-px text-[10px] font-medium text-ink-2">
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
        right={
          <span className="text-[11px] text-muted-foreground">
            current Congress · {groups.size} committee{groups.size === 1 ? "" : "s"}
          </span>
        }
      >
        Committees
      </SectionTitle>
      <Card className="p-0 sm:p-0">
        <ul className="divide-y divide-border/50">
          {[...groups.values()].map((g) => (
            <li key={g.id} className="px-4 py-2.5">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
                <a href={committeeHref(g.id)} className="font-medium hover:text-primary">
                  {g.name}
                </a>
                {g.seat ? <SeatTag seat={g.seat} /> : null}
              </div>
              {g.subs.length ? (
                <ul className="mt-1 space-y-0.5 pl-4 text-[12px]">
                  {g.subs.map((s) => (
                    <li key={s.thomas_id} className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
                      <a
                        href={committeeHref(s.thomas_id)}
                        className="text-muted-foreground underline-offset-2 hover:text-primary hover:underline"
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

/** One committee's roster with each seat holder's trading totals (`?committee=HSIF`). */
async function CommitteeView({ id }: { id: string }) {
  let committee, members, subs;
  try {
    [committee, members, subs] = await Promise.all([
      getCommittee(id),
      getCommitteeMembers(id),
      getSubcommittees(id),
    ]);
  } catch (err) {
    return <DataError error={err} />;
  }
  if (!committee) {
    return (
      <Empty>
        No committee {id}. Committee rosters are loaded with the pipeline&rsquo;s roster
        refresh.{" "}
        <a href="/politicians" className="underline underline-offset-2 hover:text-primary">
          All members
        </a>
      </Empty>
    );
  }

  // Totals over every seat, which is the whole set for this committee — not
  // a rendered slice.
  const traders = members.filter((m) => m.trades > 0).length;
  const majority = members.filter((m) => m.side === "majority").length;
  const minority = members.filter((m) => m.side === "minority").length;
  const volume = members.reduce((s, m) => s + m.volume_mid, 0);
  const late = members.reduce((s, m) => s + m.late_count, 0);
  const transcribed = members.reduce((s, m) => s + m.transcribed, 0);
  const kind = committee.parent_id ? "subcommittee" : "committee";

  return (
    <div className={PAGE_STACK}>
      <PageHeader
        back={{ href: "/politicians", label: "all members" }}
        eyebrow="Committee"
        title={committee.name}
        subtitle={
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span>
            {CHAMBER_LABEL[committee.chamber] ?? committee.chamber} {kind}
          </span>
          {committee.parent_id ? (
            <a
              href={committeeHref(committee.parent_id)}
              className="underline-offset-2 hover:text-primary hover:underline"
            >
              · of {committee.parent_name ?? committee.parent_id}
            </a>
          ) : null}
          <span className="font-mono text-xs">· {committee.thomas_id}</span>
          {committee.url ? (
            <a
              href={committee.url}
              target="_blank"
              rel="noreferrer"
              className="underline-offset-2 hover:text-primary hover:underline"
            >
              · committee site
            </a>
          ) : null}
        </span>
        }
      >
        {committee.jurisdiction ? (
          <p className="max-w-[68ch] text-[14px] leading-relaxed text-muted-foreground">
            {committee.jurisdiction}
            {committee.jurisdiction_source ? (
              <>
                {" "}
                <a
                  href={committee.jurisdiction_source}
                  target="_blank"
                  rel="noreferrer"
                  className="underline-offset-2 hover:text-primary hover:underline"
                >
                  source
                </a>
              </>
            ) : null}
          </p>
        ) : null}
      <section aria-label="Committee totals" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile
          label="Members"
          value={String(members.length)}
          hint={`${majority} majority · ${minority} minority`}
        />
        <StatTile label="With disclosed trades" value={String(traders)} hint="any counted trade" />
        <StatTile
          label="Volume (est.)"
          value={usd(volume)}
          hint={
            transcribed
              ? `bracket midpoints · ${transcribed} transcribed row${transcribed === 1 ? "" : "s"} not counted`
              : "bracket midpoints, all members"
          }
        />
        <StatTile label="Late disclosures" value={String(late)} hint="past 45 days" />
      </section>
      </PageHeader>

      {subs.length ? (
        <section>
          <SectionTitle>Subcommittees</SectionTitle>
          <Card className="p-0 sm:p-0">
            <ul className="divide-y divide-border/50 text-[13px]">
              {subs.map((s) => (
                <li key={s.thomas_id} className="flex items-center justify-between gap-3 px-4 py-2">
                  <a href={committeeHref(s.thomas_id)} className="font-medium hover:text-primary">
                    {s.name}
                  </a>
                  <span className="tabular text-[11px] text-muted-foreground">
                    {s.members} member{s.members === 1 ? "" : "s"}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        </section>
      ) : null}

      <section>
        <SectionTitle
          right={
            <span className="text-[11px] text-muted-foreground">
              delay = mean days from trade to filing
            </span>
          }
        >
          Members
        </SectionTitle>
        {members.length ? (
          <ResponsiveTable>
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-border text-left text-[12px] font-medium text-muted-foreground">
                  <th className="px-4 py-2.5 font-medium">Member</th>
                  <th className="px-4 py-2.5 font-medium">Seat</th>
                  <th className="px-4 py-2.5 text-right font-medium">Trades</th>
                  <th className="px-4 py-2.5 text-right font-medium">Tickers</th>
                  <th className="px-4 py-2.5 text-right font-medium">Buy / Sell</th>
                  <th className="px-4 py-2.5 text-right font-medium">Volume (est.)</th>
                  <th className="px-4 py-2.5 text-right font-medium">Delay</th>
                  <th className="px-4 py-2.5 text-right font-medium">Late</th>
                </tr>
              </thead>
              <tbody>
                {members.map((r) => (
                  <tr
                    key={r.bioguide_id ?? r.member_name}
                    className="border-b border-border/60 transition-colors duration-(--dur-fast) last:border-0 hover:bg-raised"
                  >
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-2">
                        <MemberAvatar name={r.member_name} bioguideId={r.bioguide_id} size="sm" />
                        {r.trades > 0 ? (
                          <a href={memberHref(r.member_name)} className="font-medium hover:text-primary">
                            {r.member_name}
                          </a>
                        ) : (
                          <span className="font-medium">{r.member_name}</span>
                        )}
                        <PartyBadge party={r.party} />
                        <span className="text-[11px] text-muted-foreground">
                          {r.state}
                          {r.district && r.district !== "0" ? r.district : ""}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-2">
                      <SeatTag seat={r} />
                    </td>
                    <td className="tabular px-4 py-2 text-right">{r.trades || "—"}</td>
                    <td className="tabular px-4 py-2 text-right text-muted-foreground">
                      {r.tickers || "—"}
                    </td>
                    <td className="tabular px-4 py-2 text-right text-muted-foreground">
                      {r.trades ? `${r.buys} / ${r.sells}` : "—"}
                    </td>
                    <td className="tabular px-4 py-2 text-right">{r.trades ? usd(r.volume_mid) : "—"}</td>
                    <td className="tabular px-4 py-2 text-right text-muted-foreground">
                      {r.avg_delay == null ? "—" : `${Math.round(r.avg_delay)}d`}
                    </td>
                    <td
                      className={`tabular px-4 py-2 text-right ${
                        r.late_count > 0
                          ? "font-medium text-red-600 dark:text-red-400"
                          : "text-muted-foreground"
                      }`}
                    >
                      {r.late_count || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ResponsiveTable>
        ) : (
          <Quiet>No seats recorded for this committee.</Quiet>
        )}
        <Disclosure
          size="sm"
          className="mt-3"
          lead={
            <>
              Each member&rsquo;s figures cover every trade they disclosed, not only trades touching this
              committee&rsquo;s jurisdiction.
            </>
          }
        >
          <p>
            Seats are the current Congress&rsquo;s roster from congress-legislators, refreshed with the
            pipeline. A member with no disclosed trades is listed with dashes.
          </p>
          <p>
            &ldquo;Late&rdquo; counts trades filed more than 45 days after the trade — a reporting fact, not an
            allegation of wrongdoing.
          </p>
        </Disclosure>
      </section>
    </div>
  );
}

/* ---------------------------------------------------------- ?view=late */

/** Filings listed on the late view, newest first; the tiles cover all. */
const LATE_FILING_PAGE = 25;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function monthLabel(month: string, withYear: boolean): string {
  const [y, m] = month.split("-");
  const name = MONTHS[Number(m) - 1] ?? month;
  return withYear || m === "01" ? `${name} ${y.slice(2)}` : name;
}

/** "12%" — one decimal under 10% so a small share does not read as zero. */
function share(n: number, of: number): string {
  if (!of) return "—";
  const pct = (n / of) * 100;
  return `${pct > 0 && pct < 10 ? pct.toFixed(1) : Math.round(pct)}%`;
}

/**
 * The ranked late-filing view. Every number here is the same measure the
 * politicians tiles report — trade date → filing date, more than 45 days —
 * and the tiles come from the same whole-dataset totals, so the two pages
 * cannot disagree.
 */
async function LateView() {
  let totals, late, members, monthly, filings;
  try {
    [totals, late, members, monthly, filings] = await Promise.all([
      getPoliticianTotals(),
      getLateTotals(),
      getLateMembers(200),
      getLateMonthly(),
      getLateFilings(LATE_FILING_PAGE),
    ]);
  } catch (err) {
    return <DataError error={err} />;
  }
  if (!members.length) {
    return (
      <Empty>
        No trades disclosed past the {STOCK_ACT_DEADLINE_DAYS}-day deadline.{" "}
        <a href="/politicians" className="underline underline-offset-2 hover:text-primary">
          All members
        </a>
      </Empty>
    );
  }

  const byWorst = [...members].sort(
    (a, b) => b.worst_delay - a.worst_delay || b.late_count - a.late_count
  );

  return (
    <div className={PAGE_STACK}>
      <PageHeader
        back={{ href: "/politicians", label: "all members" }}
        title="Late disclosures"
        subtitle={
          <>
            Trades disclosed more than {STOCK_ACT_DEADLINE_DAYS} days after they were made — the STOCK
            Act&rsquo;s deadline. A late count is a reporting fact, not an allegation of wrongdoing.
          </>
        }
      >
        <Disclosure
          size="sm"
          lead={
            <>
              Delay is measured from the trade to the date the report reached the Clerk, never the
              report&rsquo;s &ldquo;Notification Date&rdquo; column, which reads 0 for a member trading their
              own account.
            </>
          }
        />
      <section aria-label="Late totals" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile
          label="Late trades"
          value={String(totals.late_trades)}
          hint={`${share(totals.late_trades, late.trades)} of ${late.trades} disclosed trades`}
        />
        <StatTile
          label="Members late"
          value={String(totals.members_late)}
          hint={`of ${totals.members} with disclosed trades`}
        />
        <StatTile
          label="Filings with late trades"
          value={String(late.late_filings)}
          hint={`${late.all_late_filings} entirely late · of ${late.filings} filings`}
        />
        <StatTile
          label="Worst delay"
          value={late.worst_delay == null ? "—" : `${late.worst_delay}d`}
          hint="trade to filing"
        />
      </section>
      </PageHeader>

      <section className="grid gap-6 lg:grid-cols-2">
        <div>
          <SectionTitle>By late trades</SectionTitle>
          <Card>
            <MemberBars
              data={members.slice(0, 12).map((r) => ({
                key: r.member_name,
                name: r.member_name,
                bioguideId: r.bioguide_id,
                sublabel: `${r.late_count} of ${r.trades} trades · ${r.late_filings} filing${
                  r.late_filings === 1 ? "" : "s"
                }`,
                value: r.late_count,
                valueLabel: String(r.late_count),
                href: memberHref(r.member_name),
              }))}
            />
          </Card>
        </div>
        <div>
          <SectionTitle>By worst delay</SectionTitle>
          <Card>
            <MemberBars
              data={byWorst.slice(0, 12).map((r) => ({
                key: r.member_name,
                name: r.member_name,
                bioguideId: r.bioguide_id,
                sublabel: `${r.late_count} late · mean ${Math.round(r.avg_late_delay)}d`,
                value: r.worst_delay,
                valueLabel: `${r.worst_delay}d`,
                href: memberHref(r.member_name),
              }))}
            />
          </Card>
        </div>
      </section>

      <section>
        <SectionTitle
          right={
            <span className="text-[11px] text-muted-foreground">
              share of each month&rsquo;s filed trades that were late
            </span>
          }
        >
          Late share by month filed
        </SectionTitle>
        <Card>
          <ColumnSeries
            data={monthly.map((m, i) => ({
              key: m.month,
              label: monthLabel(m.month, i === 0),
              value: m.trades ? m.late_trades / m.trades : 0,
              valueLabel: share(m.late_trades, m.trades),
              detail: `${m.late_trades} of ${m.trades} trades in ${m.filings} filings`,
            }))}
          />
        </Card>
        <ResponsiveTable className="mt-4">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b border-border text-left text-[12px] font-medium text-muted-foreground">
                <th className="py-1.5 pr-3 font-medium">Month filed</th>
                <th className="py-1.5 pr-3 text-right font-medium">Filings</th>
                <th className="py-1.5 pr-3 text-right font-medium">Trades</th>
                <th className="py-1.5 pr-3 text-right font-medium">Late</th>
                <th className="py-1.5 pr-3 text-right font-medium">Share</th>
                <th className="py-1.5 text-right font-medium">Members late</th>
              </tr>
            </thead>
            <tbody>
              {monthly.map((m) => (
                <tr key={m.month} className="border-b border-border/50 last:border-0">
                  <td className="tabular py-1.5 pr-3">{m.month}</td>
                  <td className="tabular py-1.5 pr-3 text-right text-muted-foreground">{m.filings}</td>
                  <td className="tabular py-1.5 pr-3 text-right text-muted-foreground">{m.trades}</td>
                  <td
                    className={`tabular py-1.5 pr-3 text-right ${
                      m.late_trades > 0 ? "font-medium text-red-600 dark:text-red-400" : "text-muted-foreground"
                    }`}
                  >
                    {m.late_trades || "—"}
                  </td>
                  <td className="tabular py-1.5 pr-3 text-right">{share(m.late_trades, m.trades)}</td>
                  <td className="tabular py-1.5 text-right text-muted-foreground">
                    {m.members_late || "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ResponsiveTable>
        <Disclosure
          size="sm"
          className="mt-3"
          lead="By month of filing, not of trade: a trade made last month cannot be late yet."
        >
          <p>
            The ones that will be are not in the database until they are filed. A month&rsquo;s filings
            are complete once the month is over.
          </p>
        </Disclosure>
      </section>

      <section>
        <SectionTitle
          right={
            <span className="text-[11px] text-muted-foreground">
              ranked by late trades, then worst delay
            </span>
          }
        >
          All members with late trades
        </SectionTitle>
        <ResponsiveTable>
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-border text-left text-[12px] font-medium text-muted-foreground">
                <th className="px-4 py-2.5 font-medium">Member</th>
                <th className="px-4 py-2.5 text-right font-medium">Trades</th>
                <th className="px-4 py-2.5 text-right font-medium">Late</th>
                <th className="px-4 py-2.5 text-right font-medium">Share</th>
                <th className="px-4 py-2.5 text-right font-medium">Worst delay</th>
                <th className="px-4 py-2.5 text-right font-medium">Mean late delay</th>
                <th className="px-4 py-2.5 text-right font-medium">Filings</th>
                <th className="px-4 py-2.5 text-right font-medium">Last late filing</th>
              </tr>
            </thead>
            <tbody>
              {members.map((r) => (
                <tr key={r.member_name} className="border-b border-border/60 transition-colors duration-(--dur-fast) last:border-0 hover:bg-raised">
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-2">
                      <MemberAvatar name={r.member_name} bioguideId={r.bioguide_id} size="sm" />
                      <a href={memberHref(r.member_name)} className="font-medium hover:text-primary">
                        {r.member_name}
                      </a>
                      <PartyBadge party={r.party} />
                      <span className="text-[11px] text-muted-foreground">
                        {r.state}
                        {r.district && r.district !== "0" ? r.district : ""}
                      </span>
                    </div>
                  </td>
                  <td className="tabular px-4 py-2 text-right text-muted-foreground">{r.trades}</td>
                  <td className="tabular px-4 py-2 text-right font-medium text-red-600 dark:text-red-400">
                    {r.late_count}
                  </td>
                  <td className="tabular px-4 py-2 text-right">{share(r.late_count, r.trades)}</td>
                  <td className="tabular px-4 py-2 text-right">{r.worst_delay}d</td>
                  <td className="tabular px-4 py-2 text-right text-muted-foreground">
                    {Math.round(r.avg_late_delay)}d
                  </td>
                  <td className="tabular px-4 py-2 text-right text-muted-foreground">{r.late_filings}</td>
                  <td className="tabular px-4 py-2 text-right text-muted-foreground">
                    {shortDate(r.last_late_filing)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ResponsiveTable>
        <Disclosure
          size="sm"
          className="mt-3"
          lead={
            <>
              &ldquo;Worst delay&rdquo; is the longest gap from a trade to its filing; &ldquo;Mean late
              delay&rdquo; averages the late trades only. A trade whose dates contradict each other has no
              delay and is never counted as late.
            </>
          }
        />
      </section>

      <section>
        <SectionTitle
          right={
            <span className="text-[11px] text-muted-foreground">
              {filings.length < late.late_filings
                ? `newest ${filings.length} of ${late.late_filings} filings`
                : `${filings.length} filing${filings.length === 1 ? "" : "s"}`}
            </span>
          }
        >
          The filings behind the numbers
        </SectionTitle>
        <div className="space-y-3">
          {filings.map((f) => (
            <Card key={f.filing_id} className="px-4 py-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
                <PartyBadge party={f.party} />
                <a href={memberHref(f.member_name)} className="font-medium hover:text-primary">
                  {f.member_name}
                </a>
                <span className="text-[11px] text-muted-foreground">
                  {f.state}
                  {f.district && f.district !== "0" ? f.district : ""}
                </span>
                <span className="text-xs text-muted-foreground">filed {shortDate(f.filing_date)}</span>
                <span
                  className="text-xs font-medium text-red-600 dark:text-red-400"
                  title={
                    f.late.length === f.trades
                      ? "Every trade in this filing was past the deadline — its Telegram message led with how late"
                      : "Some trades in this filing were on time; the late ones are listed"
                  }
                >
                  {f.late.length === f.trades
                    ? `all ${f.trades} trade${f.trades === 1 ? "" : "s"} late`
                    : `${f.late.length} of ${f.trades} trades late`}
                </span>
                <a
                  href={f.pdf_url}
                  target="_blank"
                  rel="noreferrer"
                  className="ml-auto text-[11px] text-muted-foreground underline-offset-2 hover:text-primary hover:underline"
                >
                  filing
                </a>
              </div>
              <div className="mt-2 space-y-1">
                {f.late.map((r) => (
                  <div
                    key={r.id}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/50 pt-1 first:border-0 first:pt-0"
                  >
                    <ActionBadge action={r.action} />
                    <TickerChip ticker={r.ticker} type={r.asset_type} />
                    <Amount
                      min={r.amount_min_cents}
                      max={r.amount_max_cents}
                      exact={r.amount_exact_cents}
                    />
                    <OwnerTag owner={r.owner} />
                    <ScanTag transcribed={r.transcribed} docId={r.doc_id} />
                    <AssetName name={r.asset_name} ticker={r.ticker} className="flex-1 text-[13px]" />
                    <span className="tabular text-xs text-muted-foreground">
                      traded {shortDate(r.tx_date)}
                    </span>
                    <DelayTag days={r.delay_days} inconsistent={r.dates_inconsistent} />
                  </div>
                ))}
              </div>
            </Card>
          ))}
        </div>
      </section>
    </div>
  );
}
