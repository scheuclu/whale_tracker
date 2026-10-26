import type { Metadata } from "next";
import { assetLabel } from "@/lib/asset-label";
import { redirect } from "next/navigation";
import { getFilingSpan } from "@/lib/entities";
import {
  getInsiderFilers,
  getInsiderTotals,
  getInsiderTrackLeaderboard,
  getInsiderTrades,
  type InsiderFilerRow,
  type InsiderTrackScoreRow,
  type InsiderTradeRow,
} from "@/lib/insider-queries";
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
import {
  TRACK_BENCHMARK,
  getTrackLeaderboard,
  percent,
  points,
  type TrackScoreRow,
} from "@/lib/track-queries";
import { FILTER_KEYS, feedHref, parseOffset, parseTransactionFilters } from "@/lib/feed-filters";
import {
  insiderIssuerHref,
  memberHref,
  price,
  range,
  relativeTime,
  shares,
  shortDate,
  tickerHref,
  usd,
} from "@/lib/format";
import { Card, DivergingSplit, SectionTitle, StatTile, type StatDelta } from "./charts";
import { ExportLink, FilterBar, Pagination, ShownLine } from "./feed-controls";
import { DirectionFilter, FeedList } from "./feed-list";
import {
  ActionBadge,
  Amount,
  InsiderDelayTag,
  MoneyText,
  PartyBadge,
  PlanTag,
  RoleTag,
  Segmented,
  StatusNote,
  Tag,
  TickerChip,
} from "./ui";
import { MemberAvatar } from "./avatar";
import { Disclosure } from "./disclosure";
import { DataError, PAGE_STACK, PageHeader, Quiet } from "./page-header";
import { AgentAlternates } from "./agent-alternates";
import { GroupedList, LIST_FOOT_LINK, ROW_LINK } from "./grouped-list";
import {
  ActiveWatchlistBanner,
  FeedWatchlistToggle,
  FollowButton,
  GetAlertsPopover,
  LandingAlertBuilder,
  type StarterFollowItem,
} from "./watchlist-client";
import { ChevronRight } from "lucide-react";

export const dynamic = "force-dynamic";

/** Trades per page; `?offset=` pages through the rest, newest first. */
const PAGE = 120;

/** The stat tiles' trend window: rolling 7-day buckets back from today. */
const WEEKS = 12;

/** Trade-date window for the overlap. 30 days, not 90: this card wants both
 *  sides moving at once, and Form 4's two-business-day deadline fills the
 *  insider side immediately. */
const BOTH_SIDES_DAYS = 30;
const SIGNALS_LIMIT = 5;

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
    description: `${lead}, newest first, plus SEC Form 4 insider trades, politician & insider ratings vs S&P 500, and daily trade alerts. Amounts are shown as the ranges filed, never as invented exact figures.`,
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

type StreamMode = "congress" | "insiders" | "all";

function parseStreamMode(raw: string | string[] | undefined): StreamMode {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (v === "insiders" || v === "all") return v;
  return "congress";
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
  const stream = parseStreamMode(params.stream);
  // The filter form submits every field, blank ones included; send the
  // reader to the canonical URL so a copied link carries only the filters.
  // Not when something was ignored: the notice about it must still render.
  if (!ignored.length && FILTER_KEYS.some((k) => params[k] === "")) redirect(feedHref(filters, offset));

  const watchHasInsiderScope = Boolean(
    filters.watch && ((filters.watch.insiders?.length ?? 0) > 0 || filters.watch.tickers.length > 0)
  );
  const loadInsiderFeed = stream === "insiders" || stream === "all" || watchHasInsiderScope;

  let rows,
    totals,
    consensus,
    pipeline,
    weekly,
    insiderTotals,
    trackBoard,
    insiderTrack,
    topInsiderBuyers,
    alerts,
    bothSides,
    shared,
    insiderFeedRows;
  try {
    [
      rows,
      totals,
      consensus,
      pipeline,
      weekly,
      insiderTotals,
      trackBoard,
      insiderTrack,
      topInsiderBuyers,
      alerts,
      bothSides,
      shared,
      insiderFeedRows,
    ] = await Promise.all([
      getTransactions({ ...filters, limit: PAGE, offset }),
      getTransactionTotals(filters),
      getConsensusTickers(90, 6),
      getPipeline(),
      getWeeklyActivity(WEEKS),
      getInsiderTotals(),
      getTrackLeaderboard(90),
      getInsiderTrackLeaderboard(20),
      getInsiderFilers({ direction: "buy", limit: 6 }),
      getAlerts({ limit: SIGNALS_LIMIT }).catch(() => [] as AlertRow[]),
      getBothSides(BOTH_SIDES_DAYS, 6).catch(() => [] as BothSidesRow[]),
      getSharedTickers(BOTH_SIDES_DAYS).catch(() => ({ tickers: 0, same_direction: 0 })),
      loadInsiderFeed
        ? getInsiderTrades({
            action: filters.action === "buy" || filters.action === "sell" ? filters.action : undefined,
            ticker: filters.ticker,
            watch: filters.watch
              ? { tickers: filters.watch.tickers, insiders: filters.watch.insiders }
              : undefined,
            limit: 40,
          }).catch(() => [] as InsiderTradeRow[])
        : Promise.resolve([] as InsiderTradeRow[]),
    ]);
  } catch (err) {
    return <DataError error={err} />;
  }

  const weekLabels = rollingWeekLabels(WEEKS);

  // Curated starter chips for the Interactive Alert Builder in the hero:
  const starterPoliticians: StarterFollowItem[] = trackBoard.ranked
    .filter((m) => m.bioguide_id)
    .slice(0, 4)
    .map((m) => ({
      kind: "member",
      id: m.bioguide_id!,
      label: m.member_name,
      sub: `${m.party ?? ""}-${m.state ?? ""} · #${m.rank} on 90d track record`,
      badge: `${points(m.trade.score)} pts`,
      href: memberHref(m.member_name, m.bioguide_id),
    }));

  const insiderScoreByCik = new Map(insiderTrack.rows.map((r) => [r.cik, r]));
  const starterInsiders: StarterFollowItem[] = topInsiderBuyers.slice(0, 4).map((f) => {
    const tr = insiderScoreByCik.get(f.cik);
    return {
      kind: "insider",
      id: f.cik,
      label: f.name,
      sub: `${f.primary_ticker ?? "Form 4"} · ${usd(f.buy_value)} bought`,
      badge: tr ? `${points(tr.trade_score)} pts` : f.primary_ticker ?? undefined,
      href: `/insiders?cik=${encodeURIComponent(f.cik)}`,
    };
  });

  const starterTickers: StarterFollowItem[] = (
    bothSides.length > 0
      ? bothSides.slice(0, 5).map((r) => ({
          kind: "ticker" as const,
          id: r.ticker,
          label: r.ticker,
          sub: `${r.members} member${r.members === 1 ? "" : "s"} & ${r.insiders} insider${r.insiders === 1 ? "" : "s"} (${r.direction})`,
          badge: `${r.members}M · ${r.insiders}I`,
          href: tickerHref(r.ticker),
        }))
      : consensus.slice(0, 5).map((c) => ({
          kind: "ticker" as const,
          id: c.ticker,
          label: c.ticker,
          sub: `${c.politicians} members trading`,
          badge: `${c.buy_politicians}B/${c.sell_politicians}S`,
          href: tickerHref(c.ticker),
        }))
  );

  const streamHref = (nextStream: StreamMode) => {
    const base = feedHref(filters, offset);
    if (nextStream === "congress") return `${base}#trades`;
    const sep = base.includes("?") ? "&" : "?";
    return `${base}${sep}stream=${nextStream}#trades`;
  };

  const totalRated = trackBoard.ranked.length + insiderTrack.insiders_scored;

  return (
    <div className={PAGE_STACK}>
      <SiteStructuredData />
      <AgentAlternates markdown="/api/v1/feed.md" json="/api/v1/trades" />
      <section id="overview" className="apple-snap-section space-y-6">
        <PageHeader
          eyebrow={
            <>
              <span className="size-1.5 rounded-full bg-ok motion-safe:animate-pulse" aria-hidden />
              Congress (STOCK Act) &amp; Corporate Insiders (SEC Form 4)
            </>
          }
          title="Follow the trades that move against the market"
          subtitle="Track every stock trade disclosed by members of Congress and corporate C-suite insiders in one place. See who beats the S&P 500, spot same-direction convergence, and get daily email alerts."
        >
          <section aria-label="All disclosed trades" className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
            <StatTile
              label="Congress trades"
              value={pipeline.totals.transactions.toLocaleString()}
              hint={`STOCK Act · ${weekly.window.trades.toLocaleString()} in last ${WEEKS} wk`}
              trend={weekly.trades}
              trendLabels={weekLabels}
              trendCaption="per week"
              trendLabel={`Trades disclosed per week, last ${WEEKS} weeks, by filing date`}
              delta={tradesDelta(weekly.window.trades, weekly.priorTrades)}
            />
            <StatTile
              label="Insider trades"
              value={insiderTotals.trades.toLocaleString()}
              hint={`SEC Form 4 · ${insiderTotals.insiders.toLocaleString()} primary filers`}
            />
            <StatTile
              label="Politicians & insiders rated"
              value={totalRated.toLocaleString()}
              hint={`${trackBoard.ranked.length} members · ${insiderTrack.insiders_scored} insiders vs ${TRACK_BENCHMARK}`}
            />
            <StatTile
              label="30d convergence"
              value={shared.same_direction.toLocaleString()}
              hint={`same-way tickers · ${shared.tickers} shared overall`}
            />
          </section>
        </PageHeader>

        <LandingAlertBuilder
          politicians={starterPoliticians}
          insiders={starterInsiders}
          tickers={starterTickers}
        />
      </section>

      <RatingsShowcase
        politicians={trackBoard.ranked.slice(0, 5)}
        totalRankedPoliticians={trackBoard.ranked.length}
        insiderScores={insiderTrack.rows.slice(0, 5)}
        topInsiderBuyers={topInsiderBuyers.slice(0, 5)}
      />

      <SignalsAndConvergence alerts={alerts} rows={bothSides} shared={shared} />

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

      <section id="trades" className="apple-snap-section space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <SectionTitle
            kicker="Live Disclosures"
            className="mb-0"
          >
            Recent trades
          </SectionTitle>
          <Segmented
            label="Disclosure stream"
            items={[
              { key: "congress", href: streamHref("congress"), label: "Congress", active: stream === "congress" },
              { key: "insiders", href: streamHref("insiders"), label: "Insiders", active: stream === "insiders" },
              { key: "all", href: streamHref("all"), label: "Both", active: stream === "all" },
            ]}
          />
        </div>

        <ActiveWatchlistBanner
          activeWatch={filters.watch}
          clearHref={feedHref({ ...filters, watch: undefined })}
        />

        {(stream === "insiders" || stream === "all" || (watchHasInsiderScope && insiderFeedRows.length > 0)) ? (
          <InsiderFeedPreview
            trades={insiderFeedRows}
            isWatchFiltered={Boolean(filters.watch)}
          />
        ) : null}

        {stream !== "insiders" ? (
          <>
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
          </>
        ) : (
          <div className="hidden" aria-hidden>
            <DirectionFilter current={filters.action} hrefFor={(k) => feedHref({ ...filters, action: k })} />
          </div>
        )}
      </section>
    </div>
  );
}

/**
 * Side-by-side Track Record & Ratings showcase comparing Top-Rated Politicians
 * (90d vs SPY) and Top-Rated Corporate Insiders (SEC Form 4 conviction & 20d vs SPY).
 */
function RatingsShowcase({
  politicians,
  totalRankedPoliticians,
  insiderScores,
  topInsiderBuyers,
}: {
  politicians: TrackScoreRow[];
  totalRankedPoliticians: number;
  insiderScores: InsiderTrackScoreRow[];
  topInsiderBuyers: InsiderFilerRow[];
}) {
  if (!politicians.length && !topInsiderBuyers.length) return null;

  const scoreByCik = new Map(insiderScores.map((s) => [s.cik, s]));

  return (
    <section id="ratings" className="apple-snap-section grid gap-8 lg:grid-cols-2 lg:gap-5">
      <div className="flex min-w-0 flex-col [&>:last-child]:flex-1">
        <SectionTitle
          kicker="Congressional Ratings · 90d vs S&P 500"
          right={
            <a href="/politicians?view=track" className="ink-link text-[13px]">
              All {totalRankedPoliticians} ranked →
            </a>
          }
        >
          Top-rated politicians
        </SectionTitle>
        <GroupedList
          inset="3.25rem"
          header={
            <p className="text-[13px] text-ink-2">
              Ranked by shrunk 90-day stock move against {TRACK_BENCHMARK} after each member’s trade. No dollar amount enters the score.
            </p>
          }
          footer={
            <a href="/politicians?view=track" className={LIST_FOOT_LINK}>
              Full congressional track-record leaderboard (30d &amp; 90d)
              <ChevronRight aria-hidden className="size-3.5" strokeWidth={2.25} />
            </a>
          }
        >
          {politicians.map((m) => (
            <li
              key={m.member_name}
              className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-4 py-3 transition-colors duration-(--dur-fast) hover:bg-[var(--feed-hover)] sm:px-5"
            >
              <div className="flex min-w-0 flex-1 items-center gap-2.5">
                <span className="tabular w-5 text-right text-[12.5px] font-semibold text-muted-foreground">
                  #{m.rank}
                </span>
                <MemberAvatar name={m.member_name} bioguideId={m.bioguide_id} size="sm" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <a href={memberHref(m.member_name, m.bioguide_id)} className={ROW_LINK}>
                      {m.member_name}
                    </a>
                    <PartyBadge party={m.party} />
                    <span className="text-[12px] text-muted-foreground">
                      {m.state}
                      {m.district && m.district !== "0" ? m.district : ""}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[12px] text-muted-foreground">
                    {m.n} decisions · {percent(m.trade.hit_rate)} hit rate · after filing {points(m.disclosure.score)} pts
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2.5">
                <div className="text-right">
                  <p className="tabular text-[13.5px] font-semibold text-foreground">
                    {points(m.trade.score)} pts
                  </p>
                  <p className="text-[11px] text-muted-foreground">vs {TRACK_BENCHMARK}</p>
                </div>
                {m.bioguide_id ? (
                  <FollowButton kind="member" id={m.bioguide_id} label={m.member_name} />
                ) : null}
              </div>
            </li>
          ))}
        </GroupedList>
      </div>

      <div className="flex min-w-0 flex-col [&>:last-child]:flex-1">
        <SectionTitle
          kicker="Corporate Insider Ratings · SEC Form 4"
          right={
            <a href="/insiders?view=track" className="ink-link text-[13px]">
              Insider leaderboard →
            </a>
          }
        >
          Top corporate insiders
        </SectionTitle>
        <GroupedList
          inset="3.25rem"
          header={
            <p className="text-[13px] text-ink-2">
              C-suite officers, directors &amp; 10% owners buying their own stock on the open market (shares × reported price, kept separate from Congress).
            </p>
          }
          footer={
            <a href="/insiders?view=track" className={LIST_FOOT_LINK}>
              Full corporate insider track record (5d &amp; 20d vs {TRACK_BENCHMARK})
              <ChevronRight aria-hidden className="size-3.5" strokeWidth={2.25} />
            </a>
          }
        >
          {topInsiderBuyers.map((f) => {
            const tr = scoreByCik.get(f.cik);
            const discPct =
              f.trades > 0 ? Math.round(((f.trades - f.plan_trades) / f.trades) * 100) : 100;
            return (
              <li
                key={f.cik}
                className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-4 py-3 transition-colors duration-(--dur-fast) hover:bg-[var(--feed-hover)] sm:px-5"
              >
                <div className="flex min-w-0 flex-1 items-center gap-2.5">
                  <MemberAvatar name={f.name} size="sm" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <a href={`/insiders?cik=${encodeURIComponent(f.cik)}`} className={ROW_LINK}>
                        {f.name}
                      </a>
                      <RoleTag
                        isDirector={f.is_director}
                        isOfficer={f.is_officer}
                        isTenPercentOwner={f.is_ten_percent_owner}
                        officerTitle={f.officer_title}
                      />
                      {f.primary_ticker ? (
                        <TickerChip ticker={f.primary_ticker} href={insiderIssuerHref(f.primary_ticker)} />
                      ) : null}
                    </div>
                    <p className="mt-0.5 text-[12px] text-muted-foreground">
                      {f.buys} open-market buy{f.buys === 1 ? "" : "s"} · {discPct}% discretionary
                      {tr ? ` · ${points(tr.trade_score)} pts vs ${TRACK_BENCHMARK} (20d)` : ""}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2.5">
                  <div className="text-right">
                    <p className="tabular text-[13.5px] font-semibold text-foreground">
                      +{usd(f.buy_value)}
                    </p>
                    <p className="text-[11px] text-muted-foreground">shares × price</p>
                  </div>
                  <FollowButton kind="insider" id={f.cik} label={f.name} />
                </div>
              </li>
            );
          })}
        </GroupedList>
      </div>
    </section>
  );
}

/**
 * Corporate Insider (SEC Form 4) feed card rendered inside `#trades` when the
 * visitor selects the `Insiders` or `Both Streams` view, or when their active
 * `?watch=` filter matches Form 4 filings.
 */
function InsiderFeedPreview({
  trades,
  isWatchFiltered,
}: {
  trades: InsiderTradeRow[];
  isWatchFiltered: boolean;
}) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2 px-1">
        <p className="text-[13px] font-semibold text-foreground">
          SEC Form 4 Corporate Insider Disclosures{" "}
          <span className="font-normal text-muted-foreground">
            ({trades.length} shown · values are shares × reported price, kept separate from Congress)
          </span>
        </p>
        <a href="/insiders" className="ink-link text-[13px]">
          All corporate insider filings →
        </a>
      </div>
      {trades.length ? (
        <GroupedList>
          {trades.map((r) => (
            <li
              key={`ins:${r.id}`}
              className="px-4 py-3 transition-colors duration-(--dur-fast) hover:bg-[var(--feed-hover)] sm:px-5"
            >
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <Tag variant="outline" className="text-[11px] font-medium text-ink-2">
                  Form 4
                </Tag>
                <ActionBadge action={r.action} />
                {r.ticker ? (
                  <TickerChip ticker={r.ticker} href={insiderIssuerHref(r.ticker)} />
                ) : null}
                {r.implausible === 1 ? (
                  <span className="inline-flex items-center gap-1.5">
                    <span className="tabular text-[13px] text-muted-foreground line-through">
                      {usd(r.amount_exact_cents)}
                    </span>
                    <StatusNote tone="attention" className="text-[12px] text-ink-2">
                      as filed, implausible
                    </StatusNote>
                  </span>
                ) : (
                  <span className="font-semibold">
                    <Amount
                      min={r.amount_min_cents}
                      max={r.amount_max_cents}
                      exact={r.amount_exact_cents}
                    />
                  </span>
                )}
                <span className="tabular text-[13px] text-muted-foreground">
                  {shares(r.shares)} sh @ {price(r.price_per_share)}
                </span>
                <PlanTag value={r.aff_10b5_one} />
                <span className="ml-auto inline-flex items-center gap-2 whitespace-nowrap">
                  <span className="tabular text-[13px] text-muted-foreground">
                    {shortDate(r.tx_date)}
                  </span>
                  <InsiderDelayTag
                    days={r.delay_days}
                    late={r.late}
                    timeliness={r.timeliness}
                  />
                </span>
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13.5px]">
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
                  {r.issuer_name ?? r.security_title ?? "common stock"}
                </span>
              </div>
            </li>
          ))}
        </GroupedList>
      ) : (
        <Card>
          <Quiet>
            {isWatchFiltered
              ? "No SEC Form 4 corporate insider trades match your current watchlist filter."
              : "No SEC Form 4 corporate insider trades match this filter."}
          </Quiet>
        </Card>
      )}
    </div>
  );
}

/**
 * Two-column Bento showcase:
 * Left: Latest triggered high-signal alerts from the alert log (`getAlerts`).
 * Right: Convergence radar (`BothSides`) showing tickers traded the same way
 * by both Congress and corporate insiders in the last 30 days.
 */
function SignalsAndConvergence({
  alerts,
  rows,
  shared,
}: {
  alerts: AlertRow[];
  rows: BothSidesRow[];
  shared: SharedTickers;
}) {
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
              className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 transition-colors duration-(--dur-fast) hover:bg-[var(--feed-hover)] sm:px-5"
            >
              <div className="min-w-0 flex-1">
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
              </div>
              <FollowButton kind="ticker" id={r.ticker} label={r.ticker} />
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
