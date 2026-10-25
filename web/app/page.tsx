import type { Metadata } from "next";
import { assetLabel } from "@/lib/asset-label";
import { redirect } from "next/navigation";
import { getFilingSpan } from "@/lib/entities";
import { getInsiderTotals } from "@/lib/insider-queries";
import { pageMetadata } from "@/lib/seo";
import { datasetLd, organizationLd, websiteLd } from "@/lib/structured-data";
import { JsonLd } from "./json-ld";
import {
  getConsensusTickers,
  getPipeline,
  getTransactionTotals,
  getTransactions,
  getWeeklyActivity,
} from "@/lib/queries";
import {
  getBothSides,
  getSharedTickers,
  type BothSidesRow,
  type SharedTickers,
} from "@/lib/crossover-queries";
import {
  COUNT_NOUN,
  KIND_LABEL,
  getAlerts,
  isInsiderKind,
  type AlertKind,
  type AlertRow,
} from "@/lib/alert-queries";
import { FILTER_KEYS, feedHref, parseOffset, parseTransactionFilters } from "@/lib/feed-filters";
import { memberHref, range, relativeTime, tickerHref, usd } from "@/lib/format";
import { Card, DivergingSplit, SectionTitle, StatTile, type StatDelta } from "./charts";
import { ExportLink, FilterBar, Pagination, ShownLine } from "./feed-controls";
import { DirectionFilter, FeedList } from "./feed-list";
import { ActionBadge, MoneyText, PartyBadge, Tag, TickerChip } from "./ui";
import { Disclosure } from "./disclosure";
import { DataError, PAGE_STACK, PageHeader, Quiet } from "./page-header";
import { AgentAlternates } from "./agent-alternates";
import { GroupedList, LIST_FOOT_LINK, ROW_LINK } from "./grouped-list";
import { ActiveWatchlistBanner, FeedWatchlistToggle, GetAlertsPopover } from "./watchlist-client";
import { ChevronRight } from "lucide-react";

export const dynamic = "force-dynamic";

/** Trades per page; `?offset=` pages through the rest, newest first. */
const PAGE = 120;

/** The stat tiles' trend window: rolling 7-day buckets back from today. */
const WEEKS = 12;

/** "filed Oct 12–18" for each rolling week, oldest first — the sparkline's hover names. */
function rollingWeekLabels(weeks: number): string[] {
  const fmt = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const now = Date.now();
  const day = 86_400_000;
  return Array.from({ length: weeks }, (_, i) => {
    const ago = weeks - 1 - i;
    return `filed ${fmt(new Date(now - (ago * 7 + 6) * day))}–${fmt(new Date(now - ago * 7 * day))}`;
  });
}

/** Trades disclosed in the window against the equal window before it. No
 *  delta when the corpus does not cover the earlier window. */
function tradesDelta(current: number, prior: number | null): StatDelta | undefined {
  if (prior == null || prior === 0) return undefined;
  const pct = Math.round(((current - prior) / prior) * 100);
  return {
    direction: pct > 0 ? "up" : pct < 0 ? "down" : "flat",
    text: `${pct > 0 ? "+" : pct < 0 ? "−" : ""}${Math.abs(pct)}% vs prior ${WEEKS} wk`,
    title: `${current.toLocaleString()} trades disclosed in the last ${WEEKS} weeks, ${prior.toLocaleString()} in the ${WEEKS} before`,
  };
}

/**
 * The feed's filters and pages are views of this one page, so every variant
 * canonicalises to `/`: the newest-first list changes with each pipeline run,
 * and a filtered or offset copy of it has nothing a search result should
 * point at instead.
 */
export async function generateMetadata(): Promise<Metadata> {
  let lead = "Every stock trade members of Congress disclose under the STOCK Act";
  try {
    const p = await getPipeline();
    lead = `${p.totals.transactions.toLocaleString("en-US")} stock trades disclosed by ${p.totals.members.toLocaleString("en-US")} members of Congress under the STOCK Act`;
  } catch {
    /* generic copy */
  }
  return pageMetadata({
    title: "FatCat Watch: congressional and insider stock trades",
    absoluteTitle: true,
    description: `${lead}, newest first, plus SEC Form 4 insider trades. Amounts are shown as the ranges filed, never as invented exact figures.`,
    path: "/",
  });
}

/** Organization, WebSite (with the search action) and the Dataset node. */
async function SiteStructuredData() {
  let dataset = null;
  try {
    const [p, span, insider] = await Promise.all([
      getPipeline(),
      getFilingSpan(),
      getInsiderTotals().catch(() => ({ trades: 0 })),
    ]);
    dataset = datasetLd({
      firstFilingDate: span.first,
      lastFilingDate: span.last,
      transactions: p.totals.transactions,
      members: p.totals.members,
      insiderTrades: insider.trades,
    });
  } catch {
    /* no database: the site nodes still stand on their own */
  }
  return <JsonLd data={dataset ? [organizationLd(), websiteLd(), dataset] : [organizationLd(), websiteLd()]} />;
}

export default async function FeedPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  // The feed used to double as the member view (`?member=<name>`); that URL
  // is answered with a 308 to /members/<slug> before it gets here
  // (next.config.ts → app/api/legacy-redirect).

  const { filters, ignored } = parseTransactionFilters(params);
  const offset = parseOffset(params.offset);
  // The filter form submits every field, blank ones included; send the
  // reader to the canonical URL so a copied link carries only the filters.
  // Not when something was ignored: the notice about it must still render.
  if (!ignored.length && FILTER_KEYS.some((k) => params[k] === "")) redirect(feedHref(filters, offset));

  let rows, totals, consensus, pipeline, weekly;
  try {
    [rows, totals, consensus, pipeline, weekly] = await Promise.all([
      getTransactions({ ...filters, limit: PAGE, offset }),
      getTransactionTotals(filters),
      getConsensusTickers(90, 6),
      getPipeline(),
      getWeeklyActivity(WEEKS),
    ]);
  } catch (err) {
    return <DataError error={err} />;
  }

  const weekLabels = rollingWeekLabels(WEEKS);

  return (
    <div className={PAGE_STACK}>
      <SiteStructuredData />
      <AgentAlternates markdown="/api/v1/feed.md" json="/api/v1/trades" />
      <section id="overview" className="apple-snap-section">
        <PageHeader
          eyebrow={
            <>
              <span className="size-1.5 rounded-full bg-ok motion-safe:animate-pulse" aria-hidden />
              House &amp; Senate · STOCK Act Disclosures
            </>
          }
          title="Congressional trades"
          subtitle="Stock trades members of the House and Senate disclose under the STOCK Act, reproduced as filed. Amounts are the disclosed bracket, never one exact figure."
        >
          <section aria-label="All disclosed trades" className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
            <StatTile
              label="Trades"
              value={pipeline.totals.transactions.toLocaleString()}
              hint={`disclosed · ${weekly.window.trades.toLocaleString()} in last ${WEEKS} wk`}
              trend={weekly.trades}
              trendLabels={weekLabels}
              trendCaption="per week"
              trendLabel={`Trades disclosed per week, last ${WEEKS} weeks, by filing date`}
              delta={tradesDelta(weekly.window.trades, weekly.priorTrades)}
            />
            <StatTile
              label="Tickers"
              value={pipeline.totals.tickers.toLocaleString()}
              hint={`distinct symbols · ${weekly.window.tickers.toLocaleString()} in last ${WEEKS} wk`}
            />
            <StatTile
              label="Members"
              value={pipeline.totals.members.toLocaleString()}
              hint={`filing trades · ${weekly.window.members.toLocaleString()} in last ${WEEKS} wk`}
            />
            <StatTile
              label="Filings"
              value={pipeline.coverage.parsed.toLocaleString()}
              hint={`parsed · ${weekly.window.filings.toLocaleString()} in last ${WEEKS} wk`}
              trend={weekly.filings}
              trendLabels={weekLabels}
              trendCaption="per week"
              trendLabel={`Filings parsed per week, last ${WEEKS} weeks, by filing date`}
            />
          </section>
        </PageHeader>
      </section>

      <SignalsAndConvergence />

      {consensus.length ? (
        <section id="consensus" className="apple-snap-section">
          <SectionTitle
            kicker="Bipartisan Activity"
            right={<span className="text-muted-foreground">Last 90 days</span>}
          >
            Where members agree
          </SectionTitle>
          <Card>
            <DivergingSplit
              unit="members trading, by direction"
              data={consensus.map((c) => ({
                key: c.ticker,
                label: c.ticker,
                sublabel: assetLabel(c.asset_name, { ticker: c.ticker }) || undefined,
                buy: c.buy_politicians,
                sell: c.sell_politicians,
                href: tickerHref(c.ticker),
              }))}
            />
          </Card>
        </section>
      ) : null}

      <section id="trades" className="apple-snap-section">
        <SectionTitle
          kicker="Live Disclosures"
          right={<span className="text-muted-foreground">By trade date, newest first</span>}
        >
          Recent trades
        </SectionTitle>

        <ActiveWatchlistBanner
          activeWatch={filters.watch}
          clearHref={feedHref({ ...filters, watch: undefined })}
        />

        <FeedList
          rows={rows}
          toolbar={
            <>
              <DirectionFilter current={filters.action} hrefFor={(k) => feedHref({ ...filters, action: k })} />
              <FeedWatchlistToggle
                activeWatch={filters.watch}
                allHref={feedHref({ ...filters, watch: undefined })}
              />
              <FilterBar filters={filters} ignored={ignored} />
            </>
          }
          actions={<ExportLink filters={filters} />}
          summary={<ShownLine offset={offset} shown={rows.length} totals={totals} />}
          empty={
            offset > 0 && totals.trades ? (
              <>
                Nothing past trade {totals.trades.toLocaleString()}.{" "}
                <a href={feedHref(filters)} className="ink-link text-foreground">
                  Back to the newest
                </a>
              </>
            ) : undefined
          }
        />
        <Pagination filters={filters} offset={offset} shown={rows.length} total={totals.trades} page={PAGE} />
      </section>
    </div>
  );
}

/** Trade-date window for the overlap. 30 days, not 90: this card wants both
 *  sides moving at once, and Form 4's two-business-day deadline fills the
 *  insider side immediately. */
const BOTH_SIDES_DAYS = 30;
const SIGNALS_LIMIT = 5;

/**
 * Two-column Bento showcase right above the main feed:
 * Left: Latest triggered high-signal alerts from the alert log (`getAlerts`).
 * Right: Convergence radar (`BothSides`) showing tickers traded the same way
 * by both Congress and corporate insiders in the last 30 days.
 */
async function SignalsAndConvergence() {
  let alerts: AlertRow[] = [];
  let rows: BothSidesRow[] = [];
  let shared: SharedTickers = { tickers: 0, same_direction: 0 };
  try {
    [alerts, rows, shared] = await Promise.all([
      getAlerts({ limit: SIGNALS_LIMIT }).catch(() => []),
      getBothSides(BOTH_SIDES_DAYS, 6).catch(() => []),
      getSharedTickers(BOTH_SIDES_DAYS).catch(() => ({ tickers: 0, same_direction: 0 })),
    ]);
  } catch {
    return null;
  }
  if (!alerts.length && !rows.length) return null;

  return (
    <section id="signals" className="apple-snap-section grid gap-8 lg:grid-cols-2 lg:gap-5">
      <RecentSignalsCard alerts={alerts} />
      <BothSidesCard rows={rows} shared={shared} />
    </section>
  );
}

function SignalVolume({ a }: { a: AlertRow }) {
  const insider = isInsiderKind(a.kind);
  if (a.volume_min_cents != null) {
    return (
      <span
        className="tabular text-[12.5px] font-medium text-ink-2"
        title={insider ? "shares × reported price" : "the disclosed bracket range; the midpoint is an estimate"}
      >
        <MoneyText value={range(a.volume_min_cents, a.volume_max_cents)} />
        {!insider ? (
          <span className="text-muted-foreground">
            {" "}
            · est. <MoneyText value={usd(a.volume_mid_cents)} />
          </span>
        ) : null}
      </span>
    );
  }
  if (a.volume_mid_cents != null) {
    return (
      <span
        className="tabular text-[12.5px] font-medium text-ink-2"
        title={insider ? "shares × reported price" : "bracket-midpoint estimate; the range was not logged"}
      >
        {insider ? usd(a.volume_mid_cents) : `est. ${usd(a.volume_mid_cents)}`}
      </span>
    );
  }
  return null;
}

function RecentSignalsCard({ alerts }: { alerts: AlertRow[] }) {
  return (
    <div className="flex min-w-0 flex-col [&>:last-child]:flex-1">
      <SectionTitle
        kicker="Notable Signals"
        right={
          <span className="inline-flex items-center gap-2">
            <GetAlertsPopover />
          </span>
        }
      >
        Recent alerts
      </SectionTitle>
      {alerts.length ? (
        <GroupedList
          footer={
            <>
              <Disclosure
                size="sm"
                lead="Congressional alerts show the disclosed bracket range (midpoints are estimates); insider alerts show shares × reported price."
              >
                <p>
                  Triggered when 2+ members or 3+ corporate insiders converge on a ticker, or when a watched filer or C-suite buyer clears the alert threshold.
                </p>
              </Disclosure>
              <a href="/alerts" className={LIST_FOOT_LINK}>
                Every dispatched alert &amp; post-alert return
                <ChevronRight aria-hidden className="size-3.5" strokeWidth={2.25} />
              </a>
            </>
          }
        >
          {alerts.map((a) => {
            const kind = a.kind as AlertKind;
            const action = a.direction === "buy" ? "purchase" : a.direction === "sell" ? "sale" : null;
            const hasTicker = Boolean(a.ticker && !/^\d{10}$/.test(a.ticker));
            const who = a.member_name ?? a.participants;
            return (
              <li key={a.id} className="px-4 py-3 transition-colors duration-(--dur-fast) hover:bg-[var(--feed-hover)] sm:px-5">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
                  <Tag variant="outline" className="font-medium text-ink-2">
                    {KIND_LABEL[kind] ?? a.kind}
                  </Tag>
                  {action ? <ActionBadge action={action} /> : null}
                  {hasTicker && a.ticker ? (
                    <TickerChip
                      ticker={a.ticker}
                      href={isInsiderKind(a.kind) ? `/insiders?t=${encodeURIComponent(a.ticker)}` : undefined}
                    />
                  ) : null}
                  <SignalVolume a={a} />
                  <span className="flex-1" />
                  <time dateTime={a.fired_at} title={a.fired_at} className="tabular text-[12px] text-muted-foreground">
                    {relativeTime(a.fired_at)}
                  </time>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px] text-ink-2">
                  {(a.kind === "filing" || a.kind === "watchlist") && a.member_name ? (
                    <>
                      <a href={memberHref(a.member_name, a.bioguide_id)} className={ROW_LINK}>
                        {a.member_name}
                      </a>
                      <PartyBadge party={a.party} />
                    </>
                  ) : who ? (
                    <span className="min-w-0 truncate">{who}</span>
                  ) : null}
                  {a.window_days > 0 ? (
                    <span className="text-[12px] text-muted-foreground">
                      · {a.politician_count} {COUNT_NOUN[kind] ?? "filers"} in {a.window_days}d
                    </span>
                  ) : null}
                </div>
              </li>
            );
          })}
        </GroupedList>
      ) : (
        <Card>
          <Quiet>No alerts recorded yet.</Quiet>
        </Card>
      )}
    </div>
  );
}

/**
 * Tickers a member of Congress and a corporate insider traded the same way
 * inside the window. Two sets of books set beside each other — members from
 * House and Senate disclosures, insiders from SEC Form 4s — and never summed:
 * each count is that side's own aggregate, matched on the listed symbol alone.
 */
function BothSidesCard({ rows, shared }: { rows: BothSidesRow[]; shared: SharedTickers }) {
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

  return (
    <div id="both-sides" className="flex min-w-0 flex-col [&>:last-child]:flex-1">
      <SectionTitle
        kicker="Convergence Radar"
        right={
          <span className="text-muted-foreground">
            Last {BOTH_SIDES_DAYS}d · {shared.same_direction} same-way
          </span>
        }
      >
        Both sides
      </SectionTitle>
      {rows.length ? (
        <GroupedList
          footer={
            <>
              <Disclosure
                size="sm"
                lead={
                  <>
                    Two sets of books, never summed: members are distinct filers on House and Senate disclosures,
                    insiders are distinct primary reporting owners on SEC Form 4s.
                  </>
                }
              >
                <p>
                  Matched on the listed symbol alone. Same direction, both inside the last {BOTH_SIDES_DAYS} days on
                  trade date ({plural(shared.tickers, "ticker")} traded by both overall).
                </p>
                <p>
                  Form 4 is due in two business days and a member&apos;s report in 45, so the member side of the most
                  recent weeks is still arriving.
                </p>
              </Disclosure>
              <a href="/insiders" className={LIST_FOOT_LINK}>
                Explore corporate insider clusters
                <ChevronRight aria-hidden className="size-3.5" strokeWidth={2.25} />
              </a>
            </>
          }
        >
          {rows.map((r) => (
            <li
              key={`${r.ticker}-${r.direction}`}
              className="px-4 py-3 transition-colors duration-(--dur-fast) hover:bg-[var(--feed-hover)] sm:px-5"
            >
              <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                <TickerChip ticker={r.ticker} />
                <ActionBadge action={r.direction === "buy" ? "purchase" : "sale"} />
                <span
                  className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground"
                  title={r.issuer_name ?? r.asset_name ?? undefined}
                >
                  {assetLabel(r.issuer_name ?? r.asset_name, { ticker: r.ticker })}
                </span>
              </div>
              <div className="tabular mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px]">
                <a
                  href={tickerHref(r.ticker)}
                  className="font-medium text-foreground decoration-border-strong underline-offset-[3px] hover:underline"
                >
                  {plural(r.members, "member")}
                </a>
                <span className="text-muted-foreground">({plural(r.member_trades, "trade")})</span>
                <span aria-hidden className="text-muted-foreground">
                  ·
                </span>
                <a
                  href={`/insiders?t=${encodeURIComponent(r.ticker)}`}
                  className="font-medium text-foreground decoration-border-strong underline-offset-[3px] hover:underline"
                >
                  {plural(r.insiders, "insider")}
                </a>
                <span className="text-muted-foreground">({plural(r.insider_filings, "filing")})</span>
              </div>
            </li>
          ))}
        </GroupedList>
      ) : (
        <Card>
          <Quiet>No symbol was traded in the same direction by both sides in the last {BOTH_SIDES_DAYS} days.</Quiet>
        </Card>
      )}
    </div>
  );
}
