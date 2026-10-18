import {
  getInsiderClusters,
  getInsiderIssuer,
  getInsiderIssuers,
  getInsiderTotals,
  getInsiderTrades,
  getIssuerInsiders,
  type InsiderTradeRow,
} from "@/lib/insider-queries";
import { price, shares, shortDate, usd } from "@/lib/format";
import { Card, DivergingSplit, Empty, MagnitudeBars, SectionTitle, StatTile } from "../charts";
import { ActionBadge, Amount, InsiderDelayTag, PlanTag, RoleTag, TickerChip, ResponsiveTable } from "../ui";

export const dynamic = "force-dynamic";

/**
 * Corporate insiders — SEC Form 4. Only filings with open-market buys or
 * sells of $50k+ in one direction are stored, so every figure here is a view
 * of that subset, not of all insider activity. Values are shares × the price
 * as filed: exact, but a filer may report a weighted-average price.
 */

// 30-day default, not 90: Form 4 is due two business days after the trade,
// so a trade-date window fills almost immediately.
const WINDOWS = [
  { days: 30, label: "30d" },
  { days: 90, label: "90d" },
  { days: 365, label: "1y" },
  { days: undefined, label: "All" },
];

const VALUE_NOTE =
  "Values are shares × the price as filed; a filer may report a weighted average. " +
  "A row whose as-filed value is implausible is shown as filed and counted in no total.";

function issuerHref(ticker: string) {
  return `/insiders?t=${encodeURIComponent(ticker)}`;
}

function pill(active: boolean) {
  return `rounded-full border px-2.5 py-1 transition-colors ${
    active
      ? "border-primary/40 bg-primary/10 text-foreground"
      : "border-border text-muted-foreground hover:bg-muted"
  }`;
}

export default async function InsidersPage({
  searchParams,
}: {
  searchParams: Promise<{ t?: string; w?: string; action?: string; cik?: string }>;
}) {
  const params = await searchParams;
  if (params.t) return <IssuerDetail ticker={params.t.toUpperCase()} />;

  const windowKey = params.w ?? "30";
  const days = windowKey === "all" ? undefined : Number(windowKey) || 30;
  const query = (overrides: { w?: string; action?: string }) => {
    const q = new URLSearchParams();
    const w = "w" in overrides ? overrides.w : params.w;
    const action = "action" in overrides ? overrides.action : params.action;
    if (w) q.set("w", w);
    if (action) q.set("action", action);
    if (params.cik) q.set("cik", params.cik);
    const s = q.toString();
    return s ? `/insiders?${s}` : "/insiders";
  };

  let totals, issuers, clusters, trades;
  try {
    [totals, issuers, clusters, trades] = await Promise.all([
      getInsiderTotals(),
      getInsiderIssuers(days, 40),
      getInsiderClusters(30, 3, 12),
      getInsiderTrades({ action: params.action, cik: params.cik, days, limit: 120 }),
    ]);
  } catch (err) {
    return <Empty>{(err as Error).message}</Empty>;
  }
  if (!totals.filings) {
    return (
      <Empty>
        No insider filings yet. The pipeline stores SEC Form 4s with open-market trades of
        $50k or more once <code>EDGAR_USER_AGENT</code> is configured.
      </Empty>
    );
  }

  const mostBought = [...issuers].filter((r) => r.buy_value > 0).sort((a, b) => b.buy_value - a.buy_value);
  const mostSold = [...issuers].filter((r) => r.sell_value > 0).sort((a, b) => b.sell_value - a.sell_value);
  const filteredInsider = params.cik ? trades[0]?.insider_name : null;

  return (
    <div className="space-y-8">
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatTile label="Filings kept" value={totals.filings.toLocaleString()} hint="open-market ≥ $50k" />
        <StatTile
          label="Insider trades"
          value={totals.trades.toLocaleString()}
          hint={`${totals.buys.toLocaleString()} buy / ${totals.sells.toLocaleString()} sell`}
        />
        <StatTile label="Issuers" value={totals.issuers.toLocaleString()} hint={`${totals.insiders.toLocaleString()} insiders`} />
        <StatTile label="Bought" value={usd(totals.buy_value)} hint="shares × reported price" />
        <StatTile label="Sold" value={usd(totals.sell_value)} hint="shares × reported price" />
        <StatTile label="Late filings" value={totals.late_trades.toLocaleString()} hint="past 2 business days" />
      </section>

      <section>
        <SectionTitle right={<span className="text-[11px] text-muted-foreground">last 30 days · 3+ insiders</span>}>
          Insiders converging
        </SectionTitle>
        <Card>
          {clusters.length ? (
            <DivergingSplit
              unit="distinct insiders, by direction"
              data={clusters.map((c) => ({
                key: c.issuer_cik,
                label: c.ticker ?? "—",
                // Direction first, in words: with one arm empty the bar's side
                // alone is easy to misread, and colour must never carry it alone.
                sublabel: [
                  [
                    c.buy_insiders ? `${c.buy_insiders} bought` : null,
                    c.sell_insiders ? `${c.sell_insiders} sold` : null,
                  ]
                    .filter(Boolean)
                    .join(", "),
                  c.issuer_name?.slice(0, 22),
                ]
                  .filter(Boolean)
                  .join(" · "),
                buy: c.buy_insiders,
                sell: c.sell_insiders,
                href: c.ticker ? issuerHref(c.ticker) : undefined,
              }))}
            />
          ) : (
            <Empty>No issuer has three or more insiders trading in one direction this month.</Empty>
          )}
          <p className="mt-3 text-[11px] text-muted-foreground">
            Bought bars extend left, sold bars right. Insiders sell far more often than they buy —{" "}
            {totals.sells.toLocaleString()} of the {totals.trades.toLocaleString()} stored trades are
            sales — so a cluster of buyers is the scarcer signal. Counts primary reporting owners: a
            founder and their holding company on one filing are one insider; related parties filing
            separately still count twice.
          </p>
        </Card>
      </section>

      <div className="flex flex-wrap items-center gap-1 text-[11px]">
        {WINDOWS.map((w) => {
          const key = w.days ? String(w.days) : "all";
          return (
            <a key={w.label} href={query({ w: key })} className={pill(windowKey === key)}>
              {w.label}
            </a>
          );
        })}
        <span className="ml-2 text-muted-foreground">window measured on trade date</span>
      </div>

      <section className="grid gap-6 lg:grid-cols-2">
        <div>
          <SectionTitle>Most bought</SectionTitle>
          <Card>
            <MagnitudeBars
              data={mostBought.slice(0, 12).map((r) => ({
                key: r.issuer_cik,
                label: r.ticker ?? "—",
                sublabel: `${r.issuer_name?.slice(0, 22) ?? ""} · ${r.buy_insiders} insider${r.buy_insiders === 1 ? "" : "s"}`,
                value: r.buy_value,
                valueLabel: usd(r.buy_value),
                href: r.ticker ? issuerHref(r.ticker) : undefined,
              }))}
            />
            <p className="mt-3 text-[11px] text-muted-foreground">{VALUE_NOTE}</p>
          </Card>
        </div>
        <div>
          <SectionTitle>Most sold</SectionTitle>
          <Card>
            <MagnitudeBars
              data={mostSold.slice(0, 12).map((r) => ({
                key: r.issuer_cik,
                label: r.ticker ?? "—",
                sublabel: `${r.issuer_name?.slice(0, 22) ?? ""} · ${r.sell_insiders} insider${r.sell_insiders === 1 ? "" : "s"}`,
                value: r.sell_value,
                valueLabel: usd(r.sell_value),
                href: r.ticker ? issuerHref(r.ticker) : undefined,
              }))}
            />
            <p className="mt-3 text-[11px] text-muted-foreground">{VALUE_NOTE}</p>
          </Card>
        </div>
      </section>

      <section>
        <SectionTitle>All issuers</SectionTitle>
        {issuers.length ? (
          <ResponsiveTable>
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-border text-left text-[11px] uppercase tracking-[0.06em] text-muted-foreground">
                  <th className="px-4 py-2.5 font-medium">Ticker</th>
                  <th className="px-4 py-2.5 font-medium">Issuer</th>
                  <th className="px-4 py-2.5 text-right font-medium">Insiders</th>
                  <th className="px-4 py-2.5 text-right font-medium">Filings</th>
                  <th className="px-4 py-2.5 text-right font-medium">Buy / Sell</th>
                  <th className="px-4 py-2.5 text-right font-medium">Bought</th>
                  <th className="px-4 py-2.5 text-right font-medium">Sold</th>
                  <th className="px-4 py-2.5 text-right font-medium">Last trade</th>
                </tr>
              </thead>
              <tbody>
                {issuers.map((r) => (
                  <tr key={r.issuer_cik} className="border-b border-border/50 last:border-0 hover:bg-muted/50">
                    <td className="px-4 py-2">
                      {r.ticker ? (
                        <a href={issuerHref(r.ticker)} className="font-mono font-semibold hover:text-primary">
                          {r.ticker}
                        </a>
                      ) : (
                        <span className="text-xs text-muted-foreground">no ticker</span>
                      )}
                    </td>
                    <td className="max-w-[18rem] truncate px-4 py-2 text-muted-foreground">{r.issuer_name}</td>
                    <td className="tabular px-4 py-2 text-right font-medium">{r.insiders}</td>
                    <td className="tabular px-4 py-2 text-right text-muted-foreground">{r.filings}</td>
                    <td className="tabular px-4 py-2 text-right text-muted-foreground">
                      {r.buys} / {r.sells}
                    </td>
                    <td className="tabular px-4 py-2 text-right">{r.buy_value ? usd(r.buy_value) : "—"}</td>
                    <td className="tabular px-4 py-2 text-right">{r.sell_value ? usd(r.sell_value) : "—"}</td>
                    <td className="tabular px-4 py-2 text-right text-muted-foreground">{shortDate(r.last_tx_date)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ResponsiveTable>
        ) : (
          <Empty>No insider trades in this window.</Empty>
        )}
      </section>

      <section>
        <SectionTitle
          right={
            <div className="flex gap-1 text-[11px]">
              {[
                { k: undefined, label: "All" },
                { k: "buy", label: "Buys" },
                { k: "sell", label: "Sells" },
              ].map((f) => (
                <a key={f.label} href={query({ action: f.k })} className={pill((params.action ?? undefined) === f.k)}>
                  {f.label}
                </a>
              ))}
            </div>
          }
        >
          {filteredInsider ? `Trades — ${filteredInsider}` : "Recent trades"}
        </SectionTitle>
        {params.cik ? (
          <a href={query({})} className="mb-3 inline-block text-xs text-muted-foreground hover:text-primary">
            ← all insiders
          </a>
        ) : null}
        {trades.length ? (
          <>
            <p className="mb-3 text-xs text-muted-foreground">
              {trades.length} trades shown · {VALUE_NOTE}
            </p>
            <TradeList trades={trades} showIssuer />
          </>
        ) : (
          <Empty>No insider trades match this filter.</Empty>
        )}
      </section>
    </div>
  );
}

function TradeList({ trades, showIssuer }: { trades: InsiderTradeRow[]; showIssuer: boolean }) {
  return (
    <div className="space-y-1.5">
      {trades.map((r) => (
        <Card key={r.id} className="lift px-4 py-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <ActionBadge action={r.action} />
            {showIssuer ? (
              <TickerChip ticker={r.ticker} href={r.ticker ? issuerHref(r.ticker) : undefined} />
            ) : null}
            {r.implausible === 1 ? (
              // Reproduced, not believed: the figure is what was filed, and
              // the label says it counts toward nothing on this page.
              <span className="inline-flex items-center gap-1.5">
                <span className="tabular text-[13px] text-muted-foreground line-through decoration-amber-500/60">
                  {usd(r.amount_exact_cents)}
                </span>
                <span
                  className="text-[11px] text-amber-600 dark:text-amber-400"
                  title="The price cell appears to hold the aggregate consideration (or is otherwise beyond belief). Shown as filed; excluded from every total, cluster value and alert."
                >
                  as filed, implausible
                </span>
              </span>
            ) : (
              <Amount min={r.amount_min_cents} max={r.amount_max_cents} exact={r.amount_exact_cents} />
            )}
            <span className="tabular text-xs text-muted-foreground">
              {shares(r.shares)} sh @ {price(r.price_per_share)}
            </span>
            <PlanTag value={r.aff_10b5_one} />
            <div className="flex-1" />
            <span
              className="tabular text-xs text-muted-foreground"
              title={r.tx_date_as_filed ? `filed as "${r.tx_date_as_filed}"` : undefined}
            >
              {shortDate(r.tx_date)}
            </span>
            <InsiderDelayTag days={r.delay_days} late={r.late} timeliness={r.timeliness} />
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
            {r.insider_cik ? (
              <a href={`/insiders?cik=${encodeURIComponent(r.insider_cik)}`} className="font-medium hover:text-primary">
                {r.insider_name ?? r.insider_cik}
              </a>
            ) : (
              <span className="font-medium text-muted-foreground">unknown filer</span>
            )}
            <RoleTag
              isDirector={r.is_director}
              isOfficer={r.is_officer}
              isTenPercentOwner={r.is_ten_percent_owner}
              officerTitle={r.officer_title}
              ownerCount={r.owner_count}
            />
            <span className="truncate text-muted-foreground">
              · {showIssuer ? r.issuer_name : r.security_title ?? "common stock"}
              {r.direct_or_indirect === "I" && r.nature_of_ownership ? ` · ${r.nature_of_ownership}` : ""}
            </span>
            <a
              href={r.source_url}
              target="_blank"
              rel="noreferrer"
              className="ml-auto text-[11px] text-muted-foreground underline-offset-2 hover:text-primary hover:underline"
            >
              filing
            </a>
          </div>
        </Card>
      ))}
    </div>
  );
}

async function IssuerDetail({ ticker }: { ticker: string }) {
  let issuer, insiders, trades;
  try {
    [issuer, insiders, trades] = await Promise.all([
      getInsiderIssuer(ticker),
      getIssuerInsiders(ticker),
      getInsiderTrades({ ticker, limit: 200 }),
    ]);
  } catch (err) {
    return <Empty>{(err as Error).message}</Empty>;
  }
  if (!issuer) return <Empty>No stored insider trades for {ticker}.</Empty>;

  return (
    <div className="space-y-8">
      <div>
        <a href="/insiders" className="text-xs text-muted-foreground hover:text-primary">
          ← all insiders
        </a>
        <h1 className="mt-2 font-mono text-3xl font-semibold tracking-tight">{issuer.ticker ?? ticker}</h1>
        <p className="text-sm text-muted-foreground">
          {issuer.issuer_name} · CIK {issuer.issuer_cik}
        </p>
      </div>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <StatTile label="Insiders" value={String(issuer.insiders)} hint="primary filers" />
        <StatTile label="Filings" value={String(issuer.filings)} hint="stored Form 4s" />
        <StatTile label="Trades" value={String(issuer.trades)} hint={`${issuer.buys} buy / ${issuer.sells} sell`} />
        <StatTile label="Bought" value={issuer.buy_value ? usd(issuer.buy_value) : "—"} hint="shares × reported price" />
        <StatTile label="Sold" value={issuer.sell_value ? usd(issuer.sell_value) : "—"} hint="shares × reported price" />
      </section>

      <section>
        <SectionTitle>Who traded</SectionTitle>
        <Card className="space-y-2">
          {insiders.map((p) => (
            <div key={p.cik} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
              <a href={`/insiders?cik=${encodeURIComponent(p.cik)}`} className="font-medium hover:text-primary">
                {p.name}
              </a>
              <RoleTag
                isDirector={p.is_director}
                isOfficer={p.is_officer}
                isTenPercentOwner={p.is_ten_percent_owner}
                officerTitle={p.officer_title}
              />
              <div className="flex-1" />
              <span className="tabular text-xs text-muted-foreground">
                {p.buys} buy / {p.sells} sell
              </span>
              <span className="tabular w-24 text-right text-xs">
                {p.bought ? `+${usd(p.bought)}` : ""}
                {p.bought && p.sold ? " " : ""}
                {p.sold ? `−${usd(p.sold)}` : ""}
              </span>
            </div>
          ))}
        </Card>
      </section>

      <section>
        <SectionTitle>Every stored trade</SectionTitle>
        <p className="mb-3 text-xs text-muted-foreground">
          Open-market buys and sells from filings that cleared the $50k floor. {VALUE_NOTE}
        </p>
        <TradeList trades={trades} showIssuer={false} />
      </section>
    </div>
  );
}
