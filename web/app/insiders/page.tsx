import { assetLabel } from "@/lib/asset-label";
import {
  getInsiderClusters,
  getInsiderIssuers,
  getInsiderSectors,
  getInsiderTotals,
  getInsiderTrades,
  type InsiderSectorRow,
} from "@/lib/insider-queries";
import { insiderHref, insiderIssuerHref, shortDate, usd } from "@/lib/format";
import { getInsiderPeople } from "@/lib/insider-people";
import { GroupedList, ROW_LINK, ValueRow } from "../grouped-list";
import { Card, DivergingSplit, Empty, MagnitudeBars, SectionTitle, StatTile } from "../charts";
import { MoneyText, ResponsiveTable, RoleTag, TickerChip } from "../ui";
import { Disclosure } from "../disclosure";
import { DataError, PAGE_STACK, PageHeader, PillLinks, Quiet } from "../page-header";
import { SymbolMark } from "../symbol-hero";
import {
  ISSUER_SORT,
  ROW_LIMITS,
  isDefaultSort,
  parseLimit,
  parseSort,
  sortParams,
  type IssuerSortKey,
} from "@/lib/table-sort";
import {
  BODY_ROW,
  BarCell,
  DATA_TABLE,
  HEAD_ROW,
  SortHeader,
  SplitCell,
  TableFooter,
  describeSort,
  sortHref,
} from "../sortable-table";
import { RowLinkBody, StickyThead } from "../table-client";
import type { Metadata } from "next";
import { pageCard, pageMetadata } from "@/lib/seo";
import { InsiderTradeList } from "../insider-trade-list";
import { PeopleSwitch } from "../people-switch";

export const dynamic = "force-dynamic";

/**
 * Every window, direction, insider filter, sort and row count of the list
 * is a view of `/insiders`. An issuer (`?t=<SYMBOL>`) is the stock page now:
 * a 308 to `/tickers/<SYMBOL>#insiders` (app/api/legacy-redirect).
 */
export async function generateMetadata(): Promise<Metadata> {
  return pageMetadata({
    title: "Corporate insider trades: SEC Form 4 purchases and sales",
    description:
      "Open-market purchases and sales by corporate officers, directors and 10% owners from SEC Form 4 filings, by issuer, with clusters of insiders trading together. Values are shares × reported price.",
    path: "/insiders",
    card: pageCard("/insiders", "Corporate insider trades from SEC Form 4: insider trades, issuers, buys and sells"),
  });
}

const ISSUER_ORDER_NAMES: Record<IssuerSortKey, string> = {
  value: "value bought + sold",
  ticker: "ticker",
  issuer: "issuer name",
  insiders: "distinct insiders",
  filings: "filings",
  buysell: "share of purchases",
  bought: "value bought",
  sold: "value sold",
  last: "last trade",
};

const VALUE_HINT =
  "Shares × the price as filed: exact but computed, and a filer may report a weighted average. A dash means none in the window, or no price was filed; dashes sort last.";

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

/** The value caveat at the reading measure: the first sentence in view, the second folded. */
function ValueNote({ className }: { className?: string }) {
  return (
    <Disclosure
      size="sm"
      className={className}
      lead="Values are shares × the price as filed; a filer may report a weighted average."
    >
      <p>A row whose as-filed value is implausible is shown as filed and counted in no total.</p>
    </Disclosure>
  );
}


export default async function InsidersPage({
  searchParams,
}: {
  // `?t=` and `?cik=` are answered with a 308 (the stock page, the insider's page) before they get here.
  searchParams: Promise<{ w?: string; action?: string; sort?: string; dir?: string; n?: string }>;
}) {
  const params = await searchParams;

  const windowKey = params.w ?? "30";
  const days = windowKey === "all" ? undefined : Number(windowKey) || 30;
  const sort = parseSort(ISSUER_SORT, params);
  const { n, limit } = parseLimit(params.n);
  const rowsParam = n === "more" ? "200" : n;
  const query = (overrides: { w?: string; action?: string }) => {
    const q = new URLSearchParams();
    const w = "w" in overrides ? overrides.w : params.w;
    const action = "action" in overrides ? overrides.action : params.action;
    if (w) q.set("w", w);
    if (action) q.set("action", action);
    // The issuers table's order travels with every other link on the page.
    for (const [k, v] of Object.entries(sortParams(ISSUER_SORT, sort))) if (v) q.set(k, v);
    const s = q.toString();
    return s ? `/insiders?${s}` : "/insiders";
  };
  const tableKeep = { w: params.w, action: params.action, n: rowsParam };

  let totals, issuers, clusters, trades, sectors, table, people;
  try {
    [totals, issuers, clusters, trades, sectors, table, people] = await Promise.all([
      getInsiderTotals(),
      getInsiderIssuers(days, 40),
      getInsiderClusters(30, 3, 12),
      getInsiderTrades({ action: params.action, days, limit: 120 }),
      getInsiderSectors(days),
      // The charts rank by value; the table follows the URL's sort, applied
      // in SQL to every issuer in the window before the limit.
      !n && isDefaultSort(ISSUER_SORT, sort) ? null : getInsiderIssuers(days, limit, sort),
      getInsiderPeople(12, days).catch(() => []),
    ]);
  } catch (err) {
    return <DataError error={err} />;
  }
  table ??= issuers;
  const issuerTotal = table[0]?.total_rows ?? table.length;
  // One scale for both value columns, over the whole window, so a bar means
  // the same in either column and whichever way the table is sorted.
  const maxValue = table[0]?.max_value ?? 0;
  const withRows = (count: string) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...tableKeep, ...sortParams(ISSUER_SORT, sort), n: count })) if (v) q.set(k, v);
    return `/insiders?${q.toString()}#all-issuers`;
  };
  const issuerHeader = (column: IssuerSortKey, label: string, opts: { align?: "left" | "right"; hint?: string } = {}) => (
    <SortHeader
      spec={ISSUER_SORT}
      sort={sort}
      column={column}
      href={sortHref(ISSUER_SORT, sort, column, { path: "/insiders", keep: tableKeep, hash: "all-issuers" })}
      align={opts.align}
      hint={opts.hint}
    >
      {label}
    </SortHeader>
  );
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

  return (
    <div className={PAGE_STACK}>
      <PageHeader
        lead={<PeopleSwitch active="insiders" />}
        eyebrow="SEC Form 4"
        title="Corporate insiders"
        subtitle="Officers, directors and 10% owners trading their own company’s stock on the open market, from SEC Form 4. Only filings of $50k or more in one direction are kept."
      >
      <section aria-label="All stored insider filings" className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4">
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
      </PageHeader>

      {people.length ? (
        <section>
          <SectionTitle
            kicker="People"
            right={<span>{windowKey === "all" ? "all time" : `last ${days} days`} · shares × reported price</span>}
          >
            Insiders by value traded
          </SectionTitle>
          <GroupedList>
            {people.map((p) => (
              <ValueRow
                key={p.cik}
                name={
                  <a href={insiderHref(p.name, p.cik)} className={ROW_LINK}>
                    {p.name}
                  </a>
                }
                tags={
                  <span className="inline-flex min-w-0 items-center gap-1.5">
                    {p.latest_ticker ? <TickerChip ticker={p.latest_ticker} href={insiderIssuerHref(p.latest_ticker)} /> : null}
                    <RoleTag
                      isDirector={p.is_director}
                      isOfficer={p.is_officer}
                      isTenPercentOwner={p.is_ten_percent_owner}
                      officerTitle={p.officer_title}
                    />
                  </span>
                }
                value={
                  <MoneyText
                    value={[p.bought ? `+${usd(p.bought)}` : "", p.sold ? `−${usd(p.sold)}` : ""].filter(Boolean).join(" ") || "—"}
                  />
                }
                meta={`${p.buys} buy / ${p.sells} sell`}
              />
            ))}
          </GroupedList>
        </section>
      ) : null}

      <section>
        <SectionTitle kicker="Cluster Activity" right={<span>last 30 days · 3+ insiders</span>}>
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
                href: c.ticker ? insiderIssuerHref(c.ticker) : undefined,
              }))}
            />
          ) : (
            <Quiet>No issuer has three or more insiders trading in one direction this month.</Quiet>
          )}
          <Disclosure
            size="sm"
            className="mt-3"
            lead={
              <>
                Insiders sell far more often than they buy — {totals.sells.toLocaleString()} of the{" "}
                {totals.trades.toLocaleString()} stored trades are sales — so a cluster of buyers is the
                scarcer signal.
              </>
            }
          >
            <p>Bought bars extend left, sold bars right.</p>
            <p>
              Counts primary reporting owners: a founder and their holding company on one filing are one
              insider; related parties filing separately still count twice.
            </p>
          </Disclosure>
        </Card>
      </section>

      <div className="space-y-4">
      <PillLinks
        label="Window"
        note="window measured on trade date · applies to every section below"
        items={WINDOWS.map((w) => {
          const key = w.days ? String(w.days) : "all";
          return { href: query({ w: key }), label: w.label, active: windowKey === key };
        })}
      />

      <section className="grid gap-x-6 gap-y-7 lg:grid-cols-2">
        <div>
          <SectionTitle kicker="Purchase Volume">Most bought</SectionTitle>
          <Card>
            <MagnitudeBars
              note="shares × reported price"
              data={mostBought.slice(0, 12).map((r) => ({
                key: r.issuer_cik,
                label: r.ticker ?? "—",
                sublabel: `${assetLabel(r.issuer_name).slice(0, 22)} · ${r.buy_insiders} insider${r.buy_insiders === 1 ? "" : "s"}`,
                value: r.buy_value,
                valueLabel: usd(r.buy_value),
                title: r.issuer_name ?? undefined,
                detail: `bought by ${r.buy_insiders} insider${r.buy_insiders === 1 ? "" : "s"}`,
                href: r.ticker ? insiderIssuerHref(r.ticker) : undefined,
              }))}
            />
          </Card>
        </div>
        <div>
          <SectionTitle kicker="Sale Volume">Most sold</SectionTitle>
          <Card>
            <MagnitudeBars
              note="shares × reported price"
              data={mostSold.slice(0, 12).map((r) => ({
                key: r.issuer_cik,
                label: r.ticker ?? "—",
                sublabel: `${assetLabel(r.issuer_name).slice(0, 22)} · ${r.sell_insiders} insider${r.sell_insiders === 1 ? "" : "s"}`,
                value: r.sell_value,
                valueLabel: usd(r.sell_value),
                title: r.issuer_name ?? undefined,
                detail: `sold by ${r.sell_insiders} insider${r.sell_insiders === 1 ? "" : "s"}`,
                href: r.ticker ? insiderIssuerHref(r.ticker) : undefined,
              }))}
            />
          </Card>
        </div>
      </section>
      <ValueNote />
      </div>

      <section id="all-issuers" className="table-anchor">
        <SectionTitle kicker="Complete Directory">All issuers</SectionTitle>
        {table.length ? (
          <>
            <ResponsiveTable>
              <table className={DATA_TABLE}>
                <StickyThead>
                  <tr className={HEAD_ROW}>
                    {issuerHeader("ticker", "Ticker", { align: "left" })}
                    {issuerHeader("issuer", "Issuer", { align: "left" })}
                    {issuerHeader("insiders", "Insiders", {
                      hint: "Distinct primary reporting owners: a founder and their holding company on one filing count once.",
                    })}
                    {issuerHeader("filings", "Filings", {
                      hint: "Stored Form 4s. Related parties filing separately still count twice here.",
                    })}
                    {issuerHeader("buysell", "Buy / sell", {
                      hint: "Open-market purchases / sales. Sorts by the share that are purchases.",
                    })}
                    {issuerHeader("bought", "Bought", { hint: VALUE_HINT })}
                    {issuerHeader("sold", "Sold", { hint: VALUE_HINT })}
                    {issuerHeader("last", "Last trade")}
                  </tr>
                </StickyThead>
                <RowLinkBody>
                  {table.map((r) => (
                    <tr
                      key={r.issuer_cik}
                      className={BODY_ROW}
                      data-href={r.ticker ? insiderIssuerHref(r.ticker) : undefined}
                    >
                      <td className="px-3 py-2">
                        {r.ticker ? (
                          <div className="flex items-center gap-2">
                            <SymbolMark symbol={r.ticker} size="sm" />
                            <a href={insiderIssuerHref(r.ticker)} className="row-name font-semibold">
                              {r.ticker}
                            </a>
                          </div>
                        ) : (
                          <span className="text-[12px] text-muted-foreground">no ticker</span>
                        )}
                      </td>
                      <td className="max-w-[10rem] truncate px-3 py-2 text-muted-foreground sm:max-w-[18rem]" title={r.issuer_name ?? undefined}>
                        {r.issuer_name}
                      </td>
                      <td className="tabular px-3 py-2 text-right font-medium">{r.insiders}</td>
                      <td className="tabular px-3 py-2 text-right text-muted-foreground">{r.filings}</td>
                      <SplitCell buys={r.buys} sells={r.sells} />
                      <BarCell value={r.buy_value || null} max={maxValue} tone="buy">
                        {r.buy_value ? usd(r.buy_value) : <span className="text-muted-foreground">—</span>}
                      </BarCell>
                      <BarCell value={r.sell_value || null} max={maxValue} tone="sell">
                        {r.sell_value ? usd(r.sell_value) : <span className="text-muted-foreground">—</span>}
                      </BarCell>
                      <td className="tabular px-3 py-2 text-right text-muted-foreground">{shortDate(r.last_tx_date)}</td>
                    </tr>
                  ))}
                </RowLinkBody>
              </table>
            </ResponsiveTable>
            <TableFooter
              shown={table.length}
              total={issuerTotal}
              noun="issuers in this window"
              orderLabel={describeSort(ISSUER_SORT, sort, ISSUER_ORDER_NAMES, { last: { asc: "oldest first", desc: "newest first" } })}
              moreHref={table.length < ROW_LIMITS.more ? withRows("200") : undefined}
              allHref={withRows("all")}
            />
          </>
        ) : (
          <Quiet>No insider trades in this window.</Quiet>
        )}
      </section>

      <section>
        <SectionTitle
          kicker="Live Filings"
          right={
            <PillLinks
              label="Direction"
              items={[
                { k: undefined, label: "All" },
                { k: "buy", label: "Buys" },
                { k: "sell", label: "Sells" },
              ].map((f) => ({
                href: query({ action: f.k }),
                label: f.label,
                active: (params.action ?? undefined) === f.k,
              }))}
            />
          }
        >
          Recent trades
        </SectionTitle>
        {trades.length ? (
          <>
            <p className="mb-1 pl-1 text-[13px] text-muted-foreground">{trades.length} trades shown, newest first</p>
            <ValueNote className="mb-3 pl-1" />
            <InsiderTradeList trades={trades} showIssuer />
          </>
        ) : (
          <Quiet>No insider trades match this filter.</Quiet>
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
      <SectionTitle kicker="Industry Breakdown" right={<span>same window as above</span>}>
        By sector
      </SectionTitle>
      {classified.length ? (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <h3 className="apple-section-kicker mb-3">
              Bought
            </h3>
            {list("buy_value").length ? (
              <MagnitudeBars variant="name" note="shares × reported price" data={bars("buy_value")} />
            ) : (
              <Quiet>No priced insider purchase in this window.</Quiet>
            )}
          </Card>
          <Card>
            <h3 className="apple-section-kicker mb-3">
              Sold
            </h3>
            {list("sell_value").length ? (
              <MagnitudeBars variant="name" note="shares × reported price" data={bars("sell_value")} />
            ) : (
              <Quiet>No priced insider sale in this window.</Quiet>
            )}
          </Card>
        </div>
      ) : (
        <Quiet>
          No sector is known for any issuer yet. The pipeline classifies issuers from their
          EDGAR SIC codes after each run.
        </Quiet>
      )}
      <ValueNote className="mt-3" />
      <Disclosure
        size="sm"
        className="mt-2"
        lead={`Industry groups fold each issuer’s EDGAR SIC code into twelve sectors; ${issuersKnown} of ${issuersTotal} issuers in this window are classified.`}
      >
        <p>The rest are issuers EDGAR lists no SIC for, or ones the fill has not reached yet.</p>
      </Disclosure>
    </section>
  );
}

