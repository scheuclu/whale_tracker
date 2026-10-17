import {
  getPoliticianDetail,
  getPoliticianTickers,
  getPoliticianTotals,
  getPoliticians,
  getTransactions,
} from "@/lib/queries";
import { memberHref, shortDate, usd } from "@/lib/format";
import {
  Card,
  DivergingSplit,
  Empty,
  MagnitudeBars,
  SectionTitle,
  StatTile,
  VolumeRange,
} from "../charts";
import { ActionBadge, Amount, DelayTag, OwnerTag, PartyBadge, ScanTag, TickerChip } from "../ui";

export const dynamic = "force-dynamic";

/**
 * Trades rendered on one member's page. The stat tiles above the list are
 * aggregated over every trade, so a member with more than this many still
 * reads correctly; the list says how many it is showing.
 */
const TRADE_PAGE = 300;

export default async function PoliticiansPage({
  searchParams,
}: {
  searchParams: Promise<{ m?: string; action?: string }>;
}) {
  const params = await searchParams;
  if (params.m) return <MemberDetail member={params.m} action={params.action} />;

  let rows, totals;
  try {
    [rows, totals] = await Promise.all([getPoliticians(undefined, 80), getPoliticianTotals()]);
  } catch (err) {
    return <Empty>{(err as Error).message}</Empty>;
  }
  if (!rows.length) return <Empty>No transactions yet.</Empty>;

  const byTrades = [...rows].sort((a, b) => b.trades - a.trades);

  return (
    <div className="space-y-8">
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Members" value={String(totals.members)} hint="with disclosed trades" />
        <StatTile label="Total volume" value={usd(totals.volume_mid)} hint="estimated" />
        <StatTile label="Late disclosures" value={String(totals.late_trades)} hint="past 45 days" />
        <StatTile label="Members late" value={String(totals.members_late)} hint="at least once" />
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        <div>
          <SectionTitle>By estimated volume</SectionTitle>
          <Card>
            <MagnitudeBars
              variant="name"
              data={rows.slice(0, 12).map((r) => ({
                key: r.member_name,
                label: r.member_name,
                sublabel: `${r.party ?? "?"}-${r.state ?? "?"} · ${r.trades} trades`,
                value: r.volume_mid,
                valueLabel: usd(r.volume_mid),
                href: memberHref(r.member_name),
              }))}
            />
          </Card>
        </div>
        <div>
          <SectionTitle>By number of trades</SectionTitle>
          <Card>
            <MagnitudeBars
              variant="name"
              data={byTrades.slice(0, 12).map((r) => ({
                key: r.member_name,
                label: r.member_name,
                sublabel: `${r.tickers} distinct tickers`,
                value: r.trades,
                valueLabel: String(r.trades),
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
              delay = mean days from trade to filing
            </span>
          }
        >
          All members
        </SectionTitle>
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-border text-left text-[11px] uppercase tracking-[0.06em] text-muted-foreground">
                <th className="px-4 py-2.5 font-medium">Member</th>
                <th className="px-4 py-2.5 text-right font-medium">Trades</th>
                <th className="px-4 py-2.5 text-right font-medium">Tickers</th>
                <th className="px-4 py-2.5 text-right font-medium">Buy / Sell</th>
                <th className="px-4 py-2.5 text-right font-medium">Volume (est.)</th>
                <th className="px-4 py-2.5 text-right font-medium">Delay</th>
                <th className="px-4 py-2.5 text-right font-medium">Late</th>
                <th className="px-4 py-2.5 text-right font-medium">Notify lag</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.member_name} className="border-b border-border/50 last:border-0 hover:bg-muted/50">
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-2">
                      <PartyBadge party={r.party} />
                      <a href={memberHref(r.member_name)} className="font-medium hover:text-primary">
                        {r.member_name}
                      </a>
                      <span className="text-[11px] text-muted-foreground">
                        {r.state}
                        {r.district && r.district !== "0" ? r.district : ""}
                      </span>
                    </div>
                  </td>
                  <td className="tabular px-4 py-2 text-right">{r.trades}</td>
                  <td className="tabular px-4 py-2 text-right text-muted-foreground">{r.tickers}</td>
                  <td className="tabular px-4 py-2 text-right text-muted-foreground">
                    {r.buys} / {r.sells}
                  </td>
                  <td className="tabular px-4 py-2 text-right">{usd(r.volume_mid)}</td>
                  <td className="tabular px-4 py-2 text-right text-muted-foreground">
                    {r.avg_delay == null ? "—" : `${Math.round(r.avg_delay)}d`}
                  </td>
                  <td
                    className={`tabular px-4 py-2 text-right ${
                      r.late_count > 0 ? "font-medium text-red-600 dark:text-red-400" : "text-muted-foreground"
                    }`}
                  >
                    {r.late_count || "—"}
                  </td>
                  <td
                    className="tabular px-4 py-2 text-right text-muted-foreground"
                    title="Days until the member was notified of their own trade. A nonzero lag means someone else placed it."
                  >
                    {r.avg_lag == null ? "—" : `${Math.round(r.avg_lag)}d`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <p className="mt-3 text-[11px] text-muted-foreground">
          &ldquo;Delay&rdquo; is measured from the trade to the date the report reached
          the Clerk, and &ldquo;Late&rdquo; counts trades filed more than 45 days after
          the trade — the STOCK Act&rsquo;s deadline. A late count is a reporting
          fact, not an allegation of wrongdoing. &ldquo;Notify lag&rdquo; is a
          different measure: how long until the member learned of the trade. A
          nonzero lag means someone else placed it — a spouse, a trust or a
          managed account — and carries no compliance meaning.
        </p>
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
  let detail, tickers, trades;
  try {
    [detail, tickers, trades] = await Promise.all([
      getPoliticianDetail(member),
      getPoliticianTickers(member, 40),
      getTransactions({ member, action, limit: TRADE_PAGE }),
    ]);
  } catch (err) {
    return <Empty>{(err as Error).message}</Empty>;
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
  const chamber =
    detail.chamber === "senate" ? "Senate" : detail.chamber === "house" ? "House" : null;
  const seat = detail.state
    ? `${detail.state}${detail.district && detail.district !== "0" ? `-${detail.district}` : ""}`
    : null;

  return (
    <div className="space-y-8">
      <div>
        <a href="/politicians" className="text-xs text-muted-foreground hover:text-primary">
          ← all members
        </a>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">{detail.member_name}</h1>
        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
          <PartyBadge party={detail.party} />
          {chamber ? (
            <span>
              {chamber}
              {seat ? ` · ${seat}` : ""}
            </span>
          ) : (
            <span title="The filer's name as printed on the PDF; it did not match the House roster">
              not matched to the roster
            </span>
          )}
          <span>
            · trades from {shortDate(detail.first_tx_date)} to {shortDate(detail.last_tx_date)}
          </span>
          {detail.bioguide_id ? (
            <a
              href={`https://bioguide.congress.gov/search/bio/${detail.bioguide_id}`}
              target="_blank"
              rel="noreferrer"
              className="underline-offset-2 hover:text-primary hover:underline"
            >
              · bioguide
            </a>
          ) : null}
        </p>
      </div>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile
          label="Trades"
          value={String(detail.trades)}
          hint={`${detail.buys} buy / ${detail.sells} sell`}
        />
        <StatTile
          label="Tickers"
          value={String(detail.tickers)}
          hint={`across ${detail.filings} filing${detail.filings === 1 ? "" : "s"}`}
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

      <section>
        <SectionTitle>Disclosed volume range</SectionTitle>
        <Card>
          <VolumeRange
            min={detail.volume_min}
            max={detail.volume_max}
            mid={detail.volume_mid}
            scaleMax={scaleMax}
          />
          <p className="mt-3 text-[11px] text-muted-foreground">
            The band is the full range these disclosures permit; the tick is the
            midpoint estimate. Members report brackets, so the true figure lies
            somewhere in the band.
          </p>
        </Card>
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        <div>
          <SectionTitle>Most traded by volume</SectionTitle>
          <Card>
            <MagnitudeBars
              data={tickers.slice(0, 12).map((r) => ({
                key: r.ticker,
                label: r.ticker,
                sublabel: r.asset_name?.slice(0, 28) ?? undefined,
                value: r.volume_mid,
                valueLabel: usd(r.volume_mid),
                href: `/tickers?t=${encodeURIComponent(r.ticker)}`,
              }))}
            />
            <p className="mt-3 text-[11px] text-muted-foreground">
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
            <div className="flex gap-1 text-[11px]">
              {FILTERS.map((f) => (
                <a
                  key={f.label}
                  href={memberHref(member, f.k)}
                  className={`rounded-full border px-2.5 py-1 transition-colors ${
                    (action ?? undefined) === f.k
                      ? "border-primary/40 bg-primary/10 text-foreground"
                      : "border-border text-muted-foreground hover:bg-muted"
                  }`}
                >
                  {f.label}
                </a>
              ))}
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
            <div className="space-y-1.5">
              {trades.map((r) => (
                <Card key={r.id} className="px-4 py-3">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                    <ActionBadge action={r.action} />
                    <TickerChip ticker={r.ticker} type={r.asset_type} />
                    <Amount
                      min={r.amount_min_cents}
                      max={r.amount_max_cents}
                      exact={r.amount_exact_cents}
                    />
                    <OwnerTag owner={r.owner} />
                    <ScanTag transcribed={r.transcribed} />
                    <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">
                      {r.asset_name}
                    </span>
                    <span className="tabular text-xs text-muted-foreground">{shortDate(r.tx_date)}</span>
                    <DelayTag days={r.delay_days} inconsistent={r.dates_inconsistent} />
                    <a
                      href={r.pdf_url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[11px] text-muted-foreground underline-offset-2 hover:text-primary hover:underline"
                    >
                      filing
                    </a>
                  </div>
                </Card>
              ))}
            </div>
          </>
        ) : (
          <Empty>No trades match this filter.</Empty>
        )}
      </section>
    </div>
  );
}
