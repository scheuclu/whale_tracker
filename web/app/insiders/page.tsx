import { Fragment } from "react";
import { MoneyText } from "../money";
import { assetLabel } from "@/lib/asset-label";
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
import { insiderIssuerHref, memberHref, memberLabel, price, range, shares, shortDate, tickerHref, usd } from "@/lib/format";
import { Card, DivergingSplit, Empty, MagnitudeBars, SectionTitle, StatTile } from "../charts";
import { ActionBadge, Amount, BUTTON, InsiderDelayTag, PartyBadge, PlanTag, ResponsiveTable, RoleTag, SectorTag, StatusNote, Tag, TickerChip } from "../ui";
import { MemberAvatar } from "../avatar";
import { Disclosure } from "../disclosure";
import { PriceOverlay } from "../price-overlay";
import { BackLink, DataError, PAGE_STACK, PageHeader, PillLinks, Quiet } from "../page-header";
import { GroupedList, LIST_FOOT_LINK, ROW_LINK, ValueRow } from "../grouped-list";
import { SymbolHero, SymbolMark } from "../symbol-hero";
import { DirectionSplit, GlanceTile } from "../politicians/member-hero";
import { longDate, tradeSummary } from "@/lib/members";
import { cn } from "@/lib/utils";
import { ChevronRight } from "lucide-react";
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
import { clip, pageCard, pageMetadata } from "@/lib/seo";
import { absoluteUrl, plural } from "@/lib/site";
import { ShareControl } from "../share-control";
import { FollowButton, GetAlertsPopover } from "../watchlist-client";
import { isWatchTicker } from "@/lib/watchlist";

export const dynamic = "force-dynamic";

/**
 * An issuer (`?t=<SYMBOL>`) is its own page and canonicalises to itself;
 * every window, direction, insider filter, sort and row count of the list is
 * a view of `/insiders`.
 */
export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<{ t?: string }>;
}): Promise<Metadata> {
  const { t } = await searchParams;
  if (t) {
    const ticker = t.toUpperCase();
    const path = `/insiders?t=${encodeURIComponent(ticker)}`;
    let issuer = null;
    try {
      issuer = await getInsiderIssuer(ticker);
    } catch {
      /* fall through to the not-found copy */
    }
    if (!issuer) {
      return pageMetadata({ title: `${ticker} insider trades`, description: `No stored insider trades for ${ticker}.`, path, noindex: true });
    }
    const name = issuer.issuer_name ? ` (${issuer.issuer_name})` : "";
    return pageMetadata({
      title: `${issuer.ticker ?? ticker}${name} insider trades: SEC Form 4`,
      description: clip(
        `${plural(issuer.insiders, "corporate insider")} filed ${plural(issuer.trades, "open-market trade")} in ${issuer.ticker ?? ticker}${name} on SEC Form 4: ` +
          `${issuer.buys} buys and ${issuer.sells} sells${issuer.last_tx_date ? `, last on ${issuer.last_tx_date}` : ""}. Values are shares × reported price.`,
        200
      ),
      path,
      card: pageCard(
        `/cards/issuer/${encodeURIComponent(ticker)}`,
        `${issuer.ticker ?? ticker}${name} insider trades on SEC Form 4: ${plural(issuer.insiders, "insider")}, ${plural(issuer.filings, "filing")}, ${issuer.buys} buys and ${issuer.sells} sells`
      ),
    });
  }
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

function issuerHref(ticker: string) {
  return `/insiders?t=${encodeURIComponent(ticker)}`;
}

export default async function InsidersPage({
  searchParams,
}: {
  searchParams: Promise<{ t?: string; w?: string; action?: string; cik?: string; sort?: string; dir?: string; n?: string }>;
}) {
  const params = await searchParams;
  // Keyed so list -> detail remounts rather than morphing the list DOM.
  if (params.t) {
    const t = params.t.toUpperCase();
    return (
      <Fragment key={`t:${t}`}>
        <IssuerDetail ticker={t} />
      </Fragment>
    );
  }

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
    if (params.cik) q.set("cik", params.cik);
    // The issuers table's order travels with every other link on the page.
    for (const [k, v] of Object.entries(sortParams(ISSUER_SORT, sort))) if (v) q.set(k, v);
    const s = q.toString();
    return s ? `/insiders?${s}` : "/insiders";
  };
  const tableKeep = { w: params.w, action: params.action, cik: params.cik, n: rowsParam };

  let totals, issuers, clusters, trades, sectors, table;
  try {
    [totals, issuers, clusters, trades, sectors, table] = await Promise.all([
      getInsiderTotals(),
      getInsiderIssuers(days, 40),
      getInsiderClusters(30, 3, 12),
      getInsiderTrades({ action: params.action, cik: params.cik, days, limit: 120 }),
      getInsiderSectors(days),
      // The charts rank by value; the table follows the URL's sort, applied
      // in SQL to every issuer in the window before the limit.
      !n && isDefaultSort(ISSUER_SORT, sort) ? null : getInsiderIssuers(days, limit, sort),
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
  const filteredInsider = params.cik ? trades[0]?.insider_name : null;

  return (
    <div className={PAGE_STACK}>
      <PageHeader
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
                href: c.ticker ? issuerHref(c.ticker) : undefined,
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
                href: r.ticker ? issuerHref(r.ticker) : undefined,
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
                href: r.ticker ? issuerHref(r.ticker) : undefined,
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
                      data-href={r.ticker ? issuerHref(r.ticker) : undefined}
                    >
                      <td className="px-3 py-2">
                        {r.ticker ? (
                          <div className="flex items-center gap-2">
                            <SymbolMark symbol={r.ticker} size="sm" />
                            <a href={issuerHref(r.ticker)} className="row-name font-semibold">
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
          {filteredInsider ? `Trades — ${filteredInsider}` : "Recent trades"}
        </SectionTitle>
        {params.cik ? (
          <div className="mb-3">
            <BackLink href={query({})} label="All insiders" />
          </div>
        ) : null}
        {trades.length ? (
          <>
            <p className="mb-1 pl-1 text-[13px] text-muted-foreground">{trades.length} trades shown, newest first</p>
            <ValueNote className="mb-3 pl-1" />
            <TradeList trades={trades} showIssuer />
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

function TradeList({ trades, showIssuer }: { trades: InsiderTradeRow[]; showIssuer: boolean }) {
  return (
    // One tile, rows under inset hairlines: an iOS grouped list, like the
    // congressional trade lists (trade-row.tsx).
    <GroupedList>
      {trades.map((r) => (
        <li key={r.id} className="px-4 py-3 transition-colors duration-(--dur-fast) hover:bg-[var(--feed-hover)] sm:px-5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <ActionBadge action={r.action} />
            {showIssuer ? (
              <TickerChip ticker={r.ticker} href={r.ticker ? issuerHref(r.ticker) : undefined} />
            ) : null}
            {r.implausible === 1 ? (
              // Reproduced, not believed: the figure is what was filed, and
              // the label says it counts toward nothing on this page.
              <span className="inline-flex items-center gap-1.5">
                <span className="tabular text-[13px] text-muted-foreground line-through decoration-muted-foreground">
                  {usd(r.amount_exact_cents)}
                </span>
                <StatusNote
                  tone="attention"
                  className="text-[12px] text-ink-2"
                  title="The price cell appears to hold the aggregate consideration (or is otherwise beyond belief). Shown as filed; excluded from every total, cluster value and alert."
                >
                  as filed, implausible
                </StatusNote>
              </span>
            ) : (
              <span className="font-semibold">
                <Amount min={r.amount_min_cents} max={r.amount_max_cents} exact={r.amount_exact_cents} />
              </span>
            )}
            <span className="tabular text-[13px] text-muted-foreground">
              {shares(r.shares)} sh @ {price(r.price_per_share)}
            </span>
            {showIssuer ? (
              <SectorTag group={r.industry_group} sic={r.sic} description={r.sic_description} />
            ) : null}
            <PlanTag value={r.aff_10b5_one} />
            <span className="ml-auto inline-flex items-center gap-2 whitespace-nowrap">
              <span
                className="tabular text-[13px] text-muted-foreground"
                title={r.tx_date_as_filed ? `filed as "${r.tx_date_as_filed}"` : undefined}
              >
                {shortDate(r.tx_date)}
              </span>
              <InsiderDelayTag days={r.delay_days} late={r.late} timeliness={r.timeliness} />
            </span>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[14px]">
            {r.insider_cik ? (
              <a href={`/insiders?cik=${encodeURIComponent(r.insider_cik)}`} className={ROW_LINK}>
                {r.insider_name ?? r.insider_cik}
              </a>
            ) : (
              <span className="font-semibold text-muted-foreground">unknown filer</span>
            )}
            <RoleTag
              isDirector={r.is_director}
              isOfficer={r.is_officer}
              isTenPercentOwner={r.is_ten_percent_owner}
              officerTitle={r.officer_title}
              ownerCount={r.owner_count}
            />
            <span className="min-w-0 truncate text-[13px] text-muted-foreground">
              {showIssuer ? r.issuer_name : r.security_title ?? "common stock"}
              {r.direct_or_indirect === "I" && r.nature_of_ownership ? ` · ${r.nature_of_ownership}` : ""}
            </span>
            <a
              href={r.source_url}
              target="_blank"
              rel="noreferrer"
              className="ml-auto rounded-sm text-[12px] text-muted-foreground underline decoration-border-strong underline-offset-[3px] transition-colors duration-(--dur-fast) hover:text-foreground hover:decoration-current"
            >
              filing<span aria-hidden>&nbsp;↗</span>
              <span className="sr-only"> (opens the Form 4 on EDGAR)</span>
            </a>
          </div>
        </li>
      ))}
    </GroupedList>
  );
}

async function IssuerDetail({ ticker }: { ticker: string }) {
  let issuer, insiders, trades, congressRecent;
  try {
    [issuer, insiders, trades, congressRecent] = await Promise.all([
      getInsiderIssuer(ticker),
      getIssuerInsiders(ticker),
      getInsiderTrades({ ticker, limit: 200 }),
      getTickerDetail(ticker, CROSS_WINDOW_DAYS).catch(() => null),
    ]);
  } catch (err) {
    return <DataError error={err} />;
  }
  if (!issuer) return <Empty>No stored insider trades for {ticker}.</Empty>;
  const sym = issuer.ticker ?? ticker;
  const watchable = isWatchTicker(sym);
  // The three insiders with the most value traded, for the glance tile.
  const topInsiders = [...insiders].sort((a, b) => b.bought + b.sold - (a.bought + a.sold)).slice(0, 3);

  return (
    <div className={PAGE_STACK}>
      <header className="space-y-8 sm:space-y-10">
        <div className="mb-3 flex items-center justify-between sm:mb-4">
          <BackLink href="/insiders" label="Insiders" />
        </div>
        <SymbolHero
          symbol={issuer.ticker ?? ticker}
          identity={issuer.issuer_name}
          badges={
            <>
              <Tag>SEC Form 4</Tag>
              <SectorTag
                group={trades[0]?.industry_group}
                sic={trades[0]?.sic}
                description={trades[0]?.sic_description}
              />
            </>
          }
          summary={
            <>
              {tradeSummary({ trades: issuer.trades, tickers: 0, buys: issuer.buys, sells: issuer.sells }, plural(issuer.insiders, "insider"))}.
            </>
          }
          facts={
            <>
              {plural(issuer.filings, "filing")} · CIK {issuer.issuer_cik}
              {issuer.last_tx_date ? ` · last traded ${longDate(issuer.last_tx_date)}` : ""}
            </>
          }
          actions={
            <>
              {watchable ? (
                <>
                  <FollowButton kind="ticker" id={sym} label={sym} />
                  <GetAlertsPopover subject={{ kind: "ticker", id: sym, label: sym }} />
                </>
              ) : null}
              {congressRecent && congressRecent.politicians > 0 ? (
                <a
                  href="#congress-in-ticker"
                  className={cn(BUTTON, "h-8 px-3.5 text-[13px]")}
                  title="Jump to congressional STOCK Act trades in this symbol"
                >
                  {plural(congressRecent.politicians, "member")} in Congress (90d)
                </a>
              ) : null}
              <ShareControl
                url={absoluteUrl(insiderIssuerHref(sym))}
                text={`${sym}${issuer.issuer_name ? ` (${issuer.issuer_name})` : ""}: corporate insider trades from SEC Form 4`}
              />
            </>
          }
        />
        <div className="space-y-3 sm:space-y-4">
          <section aria-label="Issuer totals" className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
            <StatTile label="Insiders" value={String(issuer.insiders)} hint={`primary filers · ${plural(issuer.filings, "Form 4")}`} />
            <StatTile label="Trades" value={String(issuer.trades)} hint={`${issuer.buys} buy / ${issuer.sells} sell`} />
            <StatTile label="Bought" value={issuer.buy_value ? usd(issuer.buy_value) : "—"} hint="shares × reported price" />
            <StatTile label="Sold" value={issuer.sell_value ? usd(issuer.sell_value) : "—"} hint="shares × reported price" />
          </section>
          <GlanceTile
            aside={
              topInsiders.length ? (
                <>
                  <span className="mr-1 font-semibold">Largest</span>
                  {topInsiders.map((p) => (
                    <a
                      key={p.cik}
                      href={`/insiders?cik=${encodeURIComponent(p.cik)}`}
                      className={cn(BUTTON, "h-7 px-3 text-[12.5px]")}
                      title={`${p.buys} buy / ${p.sells} sell · shares × reported price`}
                    >
                      {p.name}
                    </a>
                  ))}
                </>
              ) : null
            }
          >
            <DirectionSplit
              buys={issuer.buys}
              sells={issuer.sells}
              buyers={issuer.buy_insiders}
              sellers={issuer.sell_insiders}
              noun="insider"
            />
          </GlanceTile>
        </div>
      </header>

      <PriceOverlay ticker={issuer.ticker ?? ticker} focus="insider" />

      <section>
        <SectionTitle kicker="Corporate Filers" right={<span>{plural(insiders.length, "insider")} · shares × reported price</span>}>Who traded</SectionTitle>
        <GroupedList>
          {insiders.map((p) => (
            <ValueRow
              key={p.cik}
              name={
                <a href={`/insiders?cik=${encodeURIComponent(p.cik)}`} className={ROW_LINK}>
                  {p.name}
                </a>
              }
              tags={
                <RoleTag
                  isDirector={p.is_director}
                  isOfficer={p.is_officer}
                  isTenPercentOwner={p.is_ten_percent_owner}
                  officerTitle={p.officer_title}
                />
              }
              value={
                <>
                  {p.bought ? `+${usd(p.bought)}` : ""}
                  {p.bought && p.sold ? " " : ""}
                  {p.sold ? `−${usd(p.sold)}` : ""}
                </>
              }
              meta={`${p.buys} buy / ${p.sells} sell`}
            />
          ))}
        </GroupedList>
      </section>

      <section>
        <SectionTitle kicker="Complete Ledger">Every stored trade</SectionTitle>
        <p className="mb-1 pl-1 text-[13px] text-muted-foreground">
          Open-market buys and sells from filings that cleared the $50k floor.
        </p>
        <ValueNote className="mb-3 pl-1" />
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
        <DataError error={err} context="Congressional data unavailable" />
      </section>
    );
  }
  const href = tickerHref(ticker);

  return (
    <section id="congress-in-ticker" className="table-anchor">
      <SectionTitle
        kicker="Congressional Overlap"
        right={
          <span>last {CROSS_WINDOW_DAYS} days · House &amp; Senate disclosures</span>
        }
      >
        Members of Congress in this ticker
      </SectionTitle>
      {stat ? (
        <GroupedList
          inset="3.25rem"
          header={
            <p className="text-[14px] leading-relaxed text-ink-2">
              <span className="font-semibold text-foreground">{plural(stat.politicians, "member")}</span> disclosed{" "}
              {plural(stat.trades, "trade")} —{" "}
              {[
                stat.buy_politicians ? `${stat.buy_politicians} bought` : null,
                stat.sell_politicians ? `${stat.sell_politicians} sold` : null,
              ]
                .filter(Boolean)
                .join(", ")}
              <span className="text-muted-foreground">
                {" "}
                · disclosed range <MoneyText value={range(stat.volume_min, stat.volume_max)} /> · last trade{" "}
                {shortDate(stat.last_tx_date)}
                {stat.transcribed ? ` · ${stat.transcribed} transcribed from scans, not in the range` : ""}
              </span>
            </p>
          }
          footer={
            <>
              <Disclosure
                size="sm"
                lead="Each figure is the disclosed bracket range, never a computed value. Kept apart from the Form 4 figures above — nothing here enters them."
              >
                <p>
                  Distinct filers on periodic transaction reports. A report may take 45 days to reach the Clerk,
                  so the most recent weeks are still arriving.
                </p>
              </Disclosure>
              <a href={href} className={LIST_FOOT_LINK}>
                Every disclosed trade in {ticker}
                <ChevronRight aria-hidden className="size-3.5" strokeWidth={2.25} />
              </a>
            </>
          }
        >
          {members.map((m) => (
            <ValueRow
              key={m.member_name}
              name={
                <a href={memberHref(m.member_name, m.bioguide_id)} className={cn(ROW_LINK, "inline-flex min-w-0 items-center gap-2.5")}>
                  <MemberAvatar name={m.member_name} bioguideId={m.bioguide_id} size="md" />
                  <span className="min-w-0 truncate">{memberLabel(m.member_name, null, m.state, m.district, m.chamber)}</span>
                </a>
              }
              tags={<PartyBadge party={m.party} />}
              value={<MoneyText value={range(m.volume_min, m.volume_max)} />}
              meta={`${m.buys} buy / ${m.sells} sell · last ${shortDate(m.last_tx_date)}`}
            />
          ))}
        </GroupedList>
      ) : (
        <Card>
          <Quiet>
            No disclosed member trade in {ticker} in the last {CROSS_WINDOW_DAYS} days.{" "}
            {allTime ? (
              <>
                {plural(allTime.trades, "trade")} by {plural(allTime.politicians, "member")} all-time —{" "}
                <a href={href} className="ink-link">
                  see the ticker
                </a>
                .
              </>
            ) : (
              "No member has disclosed a trade in this symbol."
            )}
          </Quiet>
        </Card>
      )}
    </section>
  );
}
