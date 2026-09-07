import { getPoliticianTotals, getPoliticians } from "@/lib/queries";
import { usd } from "@/lib/format";
import { Card, Empty, MagnitudeBars, SectionTitle, StatTile } from "../charts";
import { PartyBadge } from "../ui";

export const dynamic = "force-dynamic";

export default async function PoliticiansPage() {
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
                href: `/?member=${encodeURIComponent(r.member_name)}`,
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
                href: `/?member=${encodeURIComponent(r.member_name)}`,
              }))}
            />
          </Card>
        </div>
      </section>

      <section>
        <SectionTitle
          right={
            <span className="text-[11px] text-muted-foreground">
              delay = mean days from trade to disclosure
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
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.member_name} className="border-b border-border/50 last:border-0 hover:bg-muted/50">
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-2">
                      <PartyBadge party={r.party} />
                      <a
                        href={`/?member=${encodeURIComponent(r.member_name)}`}
                        className="font-medium hover:text-primary"
                      >
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
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <p className="mt-3 text-[11px] text-muted-foreground">
          &ldquo;Late&rdquo; counts trades disclosed more than 45 days after the trade
          date, the STOCK Act&rsquo;s deadline. A late count is a reporting fact, not
          an allegation of wrongdoing.
        </p>
      </section>
    </div>
  );
}
