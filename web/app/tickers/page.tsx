import { getTickers, getTransactions } from "@/lib/queries";
import { memberHref, memberLabel, shortDate, usd } from "@/lib/format";
import {
  Card,
  DivergingSplit,
  Empty,
  MagnitudeBars,
  SectionTitle,
  StatTile,
  VolumeRange,
} from "../charts";
import { ActionBadge, Amount, DelayTag, OwnerTag, PartyBadge, ScanTag, ResponsiveTable } from "../ui";

export const dynamic = "force-dynamic";

const WINDOWS = [
  { days: 30, label: "30d" },
  { days: 90, label: "90d" },
  { days: 365, label: "1y" },
  { days: undefined, label: "All" },
];

export default async function TickersPage({
  searchParams,
}: {
  searchParams: Promise<{ t?: string; w?: string }>;
}) {
  const params = await searchParams;
  const days = params.w === "all" ? undefined : Number(params.w) || 90;

  if (params.t) return <TickerDetail ticker={params.t.toUpperCase()} />;

  let rows;
  try {
    rows = await getTickers(days, 40);
  } catch (err) {
    return <Empty>{(err as Error).message}</Empty>;
  }
  if (!rows.length) return <Empty>No transactions in this window.</Empty>;

  const byPeople = [...rows].sort((a, b) => b.politicians - a.politicians || b.volume_mid - a.volume_mid);

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center gap-1 text-[11px]">
        {WINDOWS.map((w) => {
          const key = w.days ? String(w.days) : "all";
          const active = (params.w ?? "90") === key;
          return (
            <a
              key={w.label}
              href={`/tickers?w=${key}`}
              className={`rounded-full border px-2.5 py-1 transition-colors ${
                active
                  ? "border-primary/40 bg-primary/10 text-foreground"
                  : "border-border text-muted-foreground hover:bg-muted"
              }`}
            >
              {w.label}
            </a>
          );
        })}
        <span className="ml-2 text-muted-foreground">window measured on trade date</span>
      </div>

      <section className="grid gap-6 lg:grid-cols-2">
        <div>
          <SectionTitle>Most traded by volume</SectionTitle>
          <Card>
            <MagnitudeBars
              data={rows.slice(0, 12).map((r) => ({
                key: r.ticker,
                label: r.ticker,
                sublabel: r.asset_name?.slice(0, 28) ?? undefined,
                value: r.volume_mid,
                valueLabel: usd(r.volume_mid),
                href: `/tickers?t=${encodeURIComponent(r.ticker)}`,
              }))}
            />
            <p className="mt-3 text-[11px] text-muted-foreground">
              Estimated from disclosure brackets — see each ticker for the disclosed range.
            </p>
          </Card>
        </div>

        <div>
          <SectionTitle>Most members trading</SectionTitle>
          <Card>
            <DivergingSplit
              unit="distinct members"
              data={byPeople.slice(0, 12).map((r) => ({
                key: r.ticker,
                label: r.ticker,
                sublabel: `${r.politicians} total`,
                buy: r.buy_politicians,
                sell: r.sell_politicians,
                href: `/tickers?t=${encodeURIComponent(r.ticker)}`,
              }))}
            />
          </Card>
        </div>
      </section>

      <section>
        <SectionTitle>All tickers</SectionTitle>
        <ResponsiveTable>
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-border text-left text-[11px] uppercase tracking-[0.06em] text-muted-foreground">
                <th className="px-4 py-2.5 font-medium">Ticker</th>
                <th className="px-4 py-2.5 font-medium">Asset</th>
                <th className="px-4 py-2.5 text-right font-medium">Members</th>
                <th className="px-4 py-2.5 text-right font-medium">Trades</th>
                <th className="px-4 py-2.5 text-right font-medium">Buy / Sell</th>
                <th className="px-4 py-2.5 text-right font-medium">Volume (est.)</th>
                <th className="px-4 py-2.5 text-right font-medium">Disclosed range</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.ticker} className="border-b border-border/50 last:border-0 hover:bg-muted/50">
                  <td className="px-4 py-2">
                    <a
                      href={`/tickers?t=${encodeURIComponent(r.ticker)}`}
                      className="font-mono font-semibold hover:text-primary"
                    >
                      {r.ticker}
                    </a>
                  </td>
                  <td className="max-w-[18rem] truncate px-4 py-2 text-muted-foreground">
                    {r.asset_name}
                  </td>
                  <td className="tabular px-4 py-2 text-right font-medium">{r.politicians}</td>
                  <td className="tabular px-4 py-2 text-right text-muted-foreground">{r.trades}</td>
                  <td className="tabular px-4 py-2 text-right text-muted-foreground">
                    {r.buys} / {r.sells}
                  </td>
                  <td className="tabular px-4 py-2 text-right">{usd(r.volume_mid)}</td>
                  <td className="tabular px-4 py-2 text-right text-muted-foreground">
                    {r.volume_max == null ? `≥${usd(r.volume_min)}` : `${usd(r.volume_min)}–${usd(r.volume_max)}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ResponsiveTable>
      </section>
    </div>
  );
}

async function TickerDetail({ ticker }: { ticker: string }) {
  const [all, trades] = await Promise.all([
    getTickers(undefined, 5000),
    getTransactions({ ticker, limit: 200 }),
  ]);
  const stat = all.find((r) => r.ticker === ticker);
  if (!stat) return <Empty>No disclosed trades for {ticker}.</Empty>;

  const scaleMax = stat.volume_max ?? stat.volume_min * 2;

  return (
    <div className="space-y-8">
      <div>
        <a href="/tickers" className="text-xs text-muted-foreground hover:text-primary">
          ← all tickers
        </a>
        <h1 className="mt-2 font-mono text-3xl font-semibold tracking-tight">{stat.ticker}</h1>
        <p className="text-sm text-muted-foreground">{stat.asset_name}</p>
      </div>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Members" value={String(stat.politicians)} hint="distinct filers" />
        <StatTile label="Trades" value={String(stat.trades)} hint={`${stat.buys} buy / ${stat.sells} sell`} />
        <StatTile label="Volume (est.)" value={usd(stat.volume_mid)} hint="bracket midpoints" />
        <StatTile label="Last trade" value={shortDate(stat.last_tx_date)} />
      </section>

      <section>
        <SectionTitle>Disclosed volume range</SectionTitle>
        <Card>
          <VolumeRange
            min={stat.volume_min}
            max={stat.volume_max}
            mid={stat.volume_mid}
            scaleMax={scaleMax}
          />
          <p className="mt-3 text-[11px] text-muted-foreground">
            The band is the full range these disclosures permit; the tick is the
            midpoint estimate. Members report brackets, so the true figure lies
            somewhere in the band.
          </p>
        </Card>
      </section>

      <section>
        <SectionTitle>Every disclosed trade</SectionTitle>
        <div className="space-y-1.5">
          {trades.map((r) => (
            <Card key={r.id} className="px-4 py-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <ActionBadge action={r.action} />
                <Amount min={r.amount_min_cents} max={r.amount_max_cents} exact={r.amount_exact_cents} />
                <PartyBadge party={r.party} />
                <a href={memberHref(r.member_name)} className="text-[13px] font-medium hover:text-primary">
                  {memberLabel(r.member_name, null, r.state, r.district, r.chamber)}
                </a>
                <OwnerTag owner={r.owner} />
                <ScanTag transcribed={r.transcribed} docId={r.doc_id} />
                <div className="flex-1" />
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
      </section>
    </div>
  );
}
