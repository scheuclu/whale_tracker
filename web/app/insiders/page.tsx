import {
  getInsiderClusters,
  getInsiderIssuer,
  getInsiderIssuers,
  getInsiderSectors,
  getInsiderTotals,
  getInsiderTrades,
  getIssuerInsiders,
  type InsiderSectorRow,
  type InsiderTradeRow,
} from "@/lib/insider-queries";
import { getTickerDetail, getTickerMembers, type TickerMemberRow, type TickerRow } from "@/lib/queries";
import { memberHref, memberLabel, price, range, shares, shortDate, usd } from "@/lib/format";
import { Card, DivergingSplit, Empty, MagnitudeBars, SectionTitle, StatTile } from "../charts";
import { ActionBadge, Amount, InsiderDelayTag, PartyBadge, PlanTag, ResponsiveTable, RoleTag, SectorTag, TickerChip } from "../ui";

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

  let totals, issuers, clusters, trades, sectors;
  try {
    [totals, issuers, clusters, trades, sectors] = await Promise.all([
      getInsiderTotals(),
      getInsiderIssuers(days, 40),
      getInsiderClusters(30, 3, 12),
      getInsiderTrades({ action: params.action, cik: params.cik, days, limit: 120 }),
      getInsiderSectors(days),
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
                  c.issuer_name,
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
              note="shares × reported price"
              data={mostBought.slice(0, 12).map((r) => ({
                key: r.issuer_cik,
                label: r.ticker ?? "—",
                sublabel: `${r.issuer_name?.slice(0, 22) ?? ""} · ${r.buy_insiders} insider${r.buy_insiders === 1 ? "" : "s"}`,
                value: r.buy_value,
                valueLabel: usd(r.buy_value),
                title: r.issuer_name ?? undefined,
                detail: `bought by ${r.buy_insiders} insider${r.buy_insiders === 1 ? "" : "s"}`,
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
              note="shares × reported price"
              data={mostSold.slice(0, 12).map((r) => ({
                key: r.issuer_cik,
                label: r.ticker ?? "—",
                sublabel: `${r.issuer_name?.slice(0, 22) ?? ""} · ${r.sell_insiders} insider${r.sell_insiders === 1 ? "" : "s"}`,
                value: r.sell_value,
                valueLabel: usd(r.sell_value),
                title: r.issuer_name ?? undefined,
                detail: `sold by ${r.sell_insiders} insider${r.sell_insiders === 1 ? "" : "s"}`,
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

      <InsiderSectors sectors={sectors} />
    </div>
  );
}

/**
 * Value bought and sold per industry group inside the window (#55). Two
 * directions, two lists — the page's own "Most bought / Most sold" shape —
 * and the unclassified remainder closes each, so a sector list never claims
 * value it cannot place.
 */
function InsiderSectors({ sectors }: { sectors: InsiderSectorRow[] }) {
  const classified = sectors.filter((s) => s.industry_group);
  const unclassified = sectors.find((s) => !s.industry_group);
  const list = (key: "buy_value" | "sell_value") => [
    ...[...classified].filter((s) => s[key] > 0).sort((a, b) => b[key] - a[key]),
    ...(unclassified && unclassified[key] > 0 ? [unclassified] : []),
  ];
  const bars = (key: "buy_value" | "sell_value") =>
    list(key).map((s) => {
      const n = key === "buy_value" ? s.buys : s.sells;
      return {
        key: s.industry_group ?? "unclassified",
        label: s.industry_group ?? "Unclassified",
        sublabel: `${s.issuers} issuer${s.issuers === 1 ? "" : "s"} · ${n} trade${n === 1 ? "" : "s"}`,
        value: s[key],
        valueLabel: usd(s[key]),
      };
    });
  const issuersTotal = sectors.reduce((n, s) => n + s.issuers, 0);
  const issuersKnown = classified.reduce((n, s) => n + s.issuers, 0);
  return (
    <section>
      <SectionTitle right={<span className="text-[11px] text-muted-foreground">same window as above</span>}>
        By sector
      </SectionTitle>
      {classified.length ? (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <h3 className="mb-3 text-[11px] font-medium uppercase tracking-[0.07em] text-muted-foreground">
              Bought
            </h3>
            {list("buy_value").length ? (
              <MagnitudeBars variant="name" note="shares × reported price" data={bars("buy_value")} />
            ) : (
              <Empty>No priced insider purchase in this window.</Empty>
            )}
            <p className="mt-3 text-[11px] text-muted-foreground">{VALUE_NOTE}</p>
          </Card>
          <Card>
            <h3 className="mb-3 text-[11px] font-medium uppercase tracking-[0.07em] text-muted-foreground">
              Sold
            </h3>
            {list("sell_value").length ? (
              <MagnitudeBars variant="name" note="shares × reported price" data={bars("sell_value")} />
            ) : (
              <Empty>No priced insider sale in this window.</Empty>
            )}
            <p className="mt-3 text-[11px] text-muted-foreground">{VALUE_NOTE}</p>
          </Card>
        </div>
      ) : (
        <Card>
          <Empty>
            No sector is known for any issuer yet. The pipeline classifies issuers from their
            EDGAR SIC codes after each run.
          </Empty>
        </Card>
      )}
      <p className="mt-3 text-[11px] text-muted-foreground">
        Industry groups fold each issuer&rsquo;s EDGAR SIC code into twelve sectors.{" "}
        {issuersKnown} of {issuersTotal} issuers in this window are classified; the rest are
        issuers EDGAR lists no SIC for, or ones the fill has not reached yet.
      </p>
    </section>
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
            {showIssuer ? (
              <SectorTag group={r.industry_group} sic={r.sic} description={r.sic_description} />
            ) : null}
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
        <p className="flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
          <span>
            {issuer.issuer_name} · CIK {issuer.issuer_cik}
          </span>
          <SectorTag
            group={trades[0]?.industry_group}
            sic={trades[0]?.sic}
            description={trades[0]?.sic_description}
          />
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

      <MembersInTicker ticker={issuer.ticker ?? ticker} />
    </div>
  );
}

/** Trade-date window for the cross-link, matching the ticker page's default view. */
const CROSS_WINDOW_DAYS = 90;

/**
 * The congressional side of this symbol, set beside the Form 4 figures and
 * never added to them. Members disclose brackets, so every figure here is a
 * disclosed range (the sum of the floors to the sum of the ceilings, open-ended
 * once a trade sits in the top bracket) — not a value like the ones above.
 * Fetches its own data so a fault in the congressional tables cannot take the
 * insider page down.
 */
async function MembersInTicker({ ticker }: { ticker: string }) {
  let stat: TickerRow | null, members: TickerMemberRow[], allTime: TickerRow | null;
  try {
    [stat, members, allTime] = await Promise.all([
      getTickerDetail(ticker, CROSS_WINDOW_DAYS),
      getTickerMembers(ticker, CROSS_WINDOW_DAYS),
      getTickerDetail(ticker),
    ]);
  } catch (err) {
    return (
      <section>
        <SectionTitle>Members of Congress in this ticker</SectionTitle>
        <Empty>Congressional data unavailable: {(err as Error).message}</Empty>
      </section>
    );
  }
  const href = `/tickers?t=${encodeURIComponent(ticker)}`;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

  return (
    <section>
      <SectionTitle
        right={
          <span className="text-[11px] text-muted-foreground">
            last {CROSS_WINDOW_DAYS} days · House &amp; Senate disclosures
          </span>
        }
      >
        Members of Congress in this ticker
      </SectionTitle>
      <Card>
        {stat ? (
          <>
            <p className="text-[13px]">
              <span className="font-medium">{plural(stat.politicians, "member")}</span> disclosed{" "}
              {plural(stat.trades, "trade")} —{" "}
              {[
                stat.buy_politicians ? `${stat.buy_politicians} bought` : null,
                stat.sell_politicians ? `${stat.sell_politicians} sold` : null,
              ]
                .filter(Boolean)
                .join(", ")}
              <span className="text-muted-foreground">
                {" "}
                · disclosed range {range(stat.volume_min, stat.volume_max)} · last trade{" "}
                {shortDate(stat.last_tx_date)}
                {stat.transcribed ? ` · ${stat.transcribed} transcribed from scans, not in the range` : ""}
              </span>
            </p>
            <div className="mt-3 space-y-2">
              {members.map((m) => (
                <div key={m.member_name} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
                  <PartyBadge party={m.party} />
                  <a href={memberHref(m.member_name)} className="font-medium hover:text-primary">
                    {memberLabel(m.member_name, null, m.state, m.district, m.chamber)}
                  </a>
                  <div className="flex-1" />
                  <span className="tabular text-xs text-muted-foreground">
                    {m.buys} buy / {m.sells} sell
                  </span>
                  <span className="tabular w-28 text-right text-xs">{range(m.volume_min, m.volume_max)}</span>
                  <span className="tabular w-16 text-right text-xs text-muted-foreground">
                    {shortDate(m.last_tx_date)}
                  </span>
                </div>
              ))}
            </div>
            <p className="mt-3 text-[11px] text-muted-foreground">
              Distinct filers on periodic transaction reports; each figure is the disclosed
              bracket range, never a computed value. Kept apart from the Form 4 figures above —
              nothing here enters them. A report may take 45 days to reach the Clerk, so the
              most recent weeks are still arriving.{" "}
              <a href={href} className="underline-offset-2 hover:text-primary hover:underline">
                every disclosed trade in {ticker} →
              </a>
            </p>
          </>
        ) : (
          <Empty>
            No disclosed member trade in {ticker} in the last {CROSS_WINDOW_DAYS} days.{" "}
            {allTime ? (
              <>
                {plural(allTime.trades, "trade")} by {plural(allTime.politicians, "member")} all-time —{" "}
                <a href={href} className="underline-offset-2 hover:text-primary hover:underline">
                  see the ticker
                </a>
                .
              </>
            ) : (
              "No member has disclosed a trade in this symbol."
            )}
          </Empty>
        )}
      </Card>
    </section>
  );
}
