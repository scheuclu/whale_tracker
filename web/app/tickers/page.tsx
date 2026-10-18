import { getSectorLeaderboard, getTickers, getTransactions, type SectorRow } from "@/lib/queries";
import { memberHref, memberLabel, range, shortDate, usd } from "@/lib/format";
import {
  Card,
  DivergingSplit,
  Empty,
  MagnitudeBars,
  SectionTitle,
  StatTile,
  VOLUME_NOTE,
  VolumeRange,
} from "../charts";
import { ActionBadge, Amount, DelayTag, OptionBadge, OwnerTag, PartyBadge, ResponsiveTable, ScanTag, SectorTag } from "../ui";

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

  let rows, sectors;
  try {
    [rows, sectors] = await Promise.all([getTickers(days, 40), getSectorLeaderboard(days)]);
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
                title: r.asset_name ?? undefined,
                value: r.volume_mid,
                valueLabel: usd(r.volume_mid),
                detail: `disclosed ${range(r.volume_min, r.volume_max)}`,
                href: `/tickers?t=${encodeURIComponent(r.ticker)}`,
              }))}
              note={VOLUME_NOTE}
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

      <SectorLeaderboard sectors={sectors} />
    </div>
  );
}

/**
 * Members and trades per industry group inside the window (#55), over the
 * same ticker-bearing rows as the tables above. Two measures, two charts:
 * breadth (distinct members) and estimated volume share one hue each, and
 * the unclassified remainder closes each list so the groups never claim
 * more than they cover.
 */
function SectorLeaderboard({ sectors }: { sectors: SectorRow[] }) {
  const classified = sectors.filter((s) => s.industry_group);
  const unclassified = sectors.find((s) => !s.industry_group);
  const tail = unclassified ? [unclassified] : [];
  const byVolume = [...classified].sort((a, b) => b.volume_mid - a.volume_mid);
  const tickersTotal = sectors.reduce((n, s) => n + s.tickers, 0);
  const tickersKnown = classified.reduce((n, s) => n + s.tickers, 0);
  return (
    <section>
      <SectionTitle right={<span className="text-[11px] text-muted-foreground">same window as above</span>}>
        By sector
      </SectionTitle>
      {classified.length ? (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <h3 className="mb-3 text-[11px] font-medium uppercase tracking-[0.07em] text-muted-foreground">
              Most members trading
            </h3>
            <MagnitudeBars
              variant="name"
              data={[...classified, ...tail].map((s) => ({
                key: s.industry_group ?? "unclassified",
                label: s.industry_group ?? "Unclassified",
                sublabel: `${s.trades} trade${s.trades === 1 ? "" : "s"} · ${s.tickers} ticker${s.tickers === 1 ? "" : "s"}`,
                value: s.politicians,
                valueLabel: `${s.politicians}`,
              }))}
            />
          </Card>
          <Card>
            <h3 className="mb-3 text-[11px] font-medium uppercase tracking-[0.07em] text-muted-foreground">
              Estimated volume
            </h3>
            <MagnitudeBars
              variant="name"
              data={[...byVolume, ...tail].map((s) => ({
                key: s.industry_group ?? "unclassified",
                label: s.industry_group ?? "Unclassified",
                sublabel: `disclosed ${range(s.volume_min, s.volume_max)}`,
                value: s.volume_mid,
                valueLabel: usd(s.volume_mid),
                detail: `disclosed ${range(s.volume_min, s.volume_max)}`,
              }))}
              note={VOLUME_NOTE}
            />
            <p className="mt-3 text-[11px] text-muted-foreground">
              Bracket midpoints; the disclosed range is under each bar.
            </p>
          </Card>
        </div>
      ) : (
        <Card>
          <Empty>
            No sector is known for any ticker yet. The pipeline classifies issuers from their
            EDGAR SIC codes after each run.
          </Empty>
        </Card>
      )}
      <p className="mt-3 text-[11px] text-muted-foreground">
        Industry groups fold each issuer&rsquo;s EDGAR SIC code into twelve sectors.{" "}
        {tickersKnown} of {tickersTotal} tickers in this window are classified; the rest are
        ETF trusts and other issuers EDGAR lists no SIC for, symbols not in EDGAR&rsquo;s
        company list, or issuers the fill has not reached yet.
      </p>
    </section>
  );
}

async function TickerDetail({ ticker }: { ticker: string }) {
  const [all, trades, optionTrades] = await Promise.all([
    getTickers(undefined, 5000),
    getTransactions({ ticker, limit: 200 }),
    getTransactions({ ticker, options: true, limit: 500 }),
  ]);
  const stat = all.find((r) => r.ticker === ticker);
  if (!stat) return <Empty>No disclosed trades for {ticker}.</Empty>;

  const scaleMax = stat.volume_max ?? stat.volume_min * 2;
  const calls = optionTrades.filter((r) => r.option_kind === "call").length;
  const puts = optionTrades.filter((r) => r.option_kind === "put").length;

  return (
    <div className="space-y-8">
      <div>
        <a href="/tickers" className="text-xs text-muted-foreground hover:text-primary">
          ← all tickers
        </a>
        <h1 className="mt-2 font-mono text-3xl font-semibold tracking-tight">{stat.ticker}</h1>
        <p className="flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
          <span>{stat.asset_name}</span>
          <SectorTag
            group={trades[0]?.industry_group}
            sic={trades[0]?.sic}
            description={trades[0]?.sic_description}
          />
        </p>
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
                <OptionBadge kind={r.option_kind} strikeCents={r.strike_cents} expiry={r.expiry} />
                <Amount min={r.amount_min_cents} max={r.amount_max_cents} exact={r.amount_exact_cents} />
                <SectorTag group={r.industry_group} sic={r.sic} description={r.sic_description} />
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

      {optionTrades.length ? (
        <section>
          <SectionTitle
            right={
              <span className="text-[11px] text-muted-foreground">
                {calls} call{calls === 1 ? "" : "s"} · {puts} put{puts === 1 ? "" : "s"}
              </span>
            }
          >
            Options
          </SectionTitle>
          <ResponsiveTable>
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-border text-left text-[11px] uppercase tracking-[0.06em] text-muted-foreground">
                  <th className="px-4 py-2.5 font-medium">Contract</th>
                  <th className="px-4 py-2.5 font-medium">Action</th>
                  <th className="px-4 py-2.5 font-medium">Member</th>
                  <th className="px-4 py-2.5 text-right font-medium">Disclosed range</th>
                  <th className="px-4 py-2.5 text-right font-medium">Traded</th>
                  <th className="px-4 py-2.5 text-right font-medium">Expires</th>
                  <th className="px-4 py-2.5 text-right font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {optionTrades.map((r) => (
                  <tr key={r.id} className="border-b border-border/50 last:border-0 hover:bg-muted/50">
                    <td className="px-4 py-2">
                      <OptionBadge kind={r.option_kind} strikeCents={r.strike_cents} expiry={null} />
                    </td>
                    <td className="px-4 py-2">
                      <ActionBadge action={r.action} />
                    </td>
                    <td className="px-4 py-2">
                      <a href={memberHref(r.member_name)} className="font-medium hover:text-primary">
                        {memberLabel(r.member_name, r.party, r.state, r.district, r.chamber)}
                      </a>
                      <OwnerTag owner={r.owner} />
                    </td>
                    <td className="tabular px-4 py-2 text-right">
                      <Amount min={r.amount_min_cents} max={r.amount_max_cents} exact={r.amount_exact_cents} />
                    </td>
                    <td className="tabular px-4 py-2 text-right text-muted-foreground">{shortDate(r.tx_date)}</td>
                    <td className="tabular px-4 py-2 text-right text-muted-foreground">
                      {r.expiry ? shortDate(r.expiry) : <span title="The filing did not print an expiry">—</span>}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <a
                        href={r.pdf_url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-[11px] text-muted-foreground underline-offset-2 hover:text-primary hover:underline"
                      >
                        filing
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ResponsiveTable>
          <p className="mt-3 text-[11px] text-muted-foreground">
            Kind, strike and expiry are read from each filing&apos;s own text and shown only when
            printed; a put bought is listed as the purchase it was filed as. Amounts are the
            disclosed brackets.
          </p>
        </section>
      ) : null}
    </div>
  );
}
