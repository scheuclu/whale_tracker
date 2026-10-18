import {
  STOCK_ACT_DEADLINE_DAYS,
  getLateFilings,
  getLateMembers,
  getLateMonthly,
  getLateTotals,
  getPoliticianDetail,
  getPoliticianTickers,
  getPoliticianTotals,
  getPoliticians,
  getTransactions,
} from "@/lib/queries";
import { getScanFilings } from "@/lib/scan-queries";
import { memberHref, shortDate, usd } from "@/lib/format";
import {
  Card,
  ColumnSeries,
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
  searchParams: Promise<{ m?: string; action?: string; view?: string }>;
}) {
  const params = await searchParams;
  if (params.m) return <MemberDetail member={params.m} action={params.action} />;
  if (params.view === "late") return <LateView />;

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
  let detail, tickers, trades, scans;
  try {
    [detail, tickers, trades, scans] = await Promise.all([
      getPoliticianDetail(member),
      getPoliticianTickers(member, 40),
      getTransactions({ member, action, limit: TRADE_PAGE }),
      getScanFilings({ member }),
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
            <span title="The filer's name as printed on the filing; it did not match the congressional roster">
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
          {scans.length ? (
            <a
              href={`/scans?m=${encodeURIComponent(member)}`}
              className="underline-offset-2 hover:text-primary hover:underline"
              title="Paper filings scanned without a text layer; inspect what the grid reader saw"
            >
              · {scans.length} scanned filing{scans.length === 1 ? "" : "s"}
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
                    <ScanTag transcribed={r.transcribed} docId={r.doc_id} />
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
    return <Empty>{(err as Error).message}</Empty>;
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
    <div className="space-y-8">
      <div>
        <a href="/politicians" className="text-xs text-muted-foreground hover:text-primary">
          ← all members
        </a>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">Late disclosures</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Trades disclosed more than {STOCK_ACT_DEADLINE_DAYS} days after they were made — the
          STOCK Act&rsquo;s deadline. Delay is measured from the trade to the date the report
          reached the Clerk, never the report&rsquo;s &ldquo;Notification Date&rdquo; column,
          which reads 0 for a member trading their own account. A late count is a reporting
          fact, not an allegation of wrongdoing.
        </p>
      </div>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
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

      <section className="grid gap-6 lg:grid-cols-2">
        <div>
          <SectionTitle>By late trades</SectionTitle>
          <Card>
            <MagnitudeBars
              variant="name"
              data={members.slice(0, 12).map((r) => ({
                key: r.member_name,
                label: r.member_name,
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
            <MagnitudeBars
              variant="name"
              data={byWorst.slice(0, 12).map((r) => ({
                key: r.member_name,
                label: r.member_name,
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
          <table className="mt-4 w-full text-[12px]">
            <thead>
              <tr className="border-b border-border text-left text-[11px] uppercase tracking-[0.06em] text-muted-foreground">
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
          <p className="mt-3 text-[11px] text-muted-foreground">
            By month of filing, not of trade: a trade made last month cannot be late yet, and
            the ones that will be are not in the database until they are filed. A month&rsquo;s
            filings are complete once the month is over.
          </p>
        </Card>
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
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-border text-left text-[11px] uppercase tracking-[0.06em] text-muted-foreground">
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
        </Card>
        <p className="mt-3 text-[11px] text-muted-foreground">
          &ldquo;Worst delay&rdquo; is the longest gap from a trade to its filing;
          &ldquo;Mean late delay&rdquo; averages the late trades only. A trade whose dates
          contradict each other has no delay and is never counted as late.
        </p>
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
                    <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">
                      {r.asset_name}
                    </span>
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
