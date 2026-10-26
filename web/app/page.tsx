import type { Metadata } from "next";
import { Bell, Mail, Star, Users } from "lucide-react";
import { getFilingSpan } from "@/lib/entities";
import { getInsiderTotals, getInsiderTrades, type InsiderTradeRow } from "@/lib/insider-queries";
import { getConsensusTickers, getPipeline, getTransactions, type TransactionRow } from "@/lib/queries";
import { getTrackLeaderboard, points, type TrackScoreRow } from "@/lib/track-queries";
import { assetLabel } from "@/lib/asset-label";
import { insiderIssuerHref, memberHref, memberLabel, relativeTime, shortDate, tickerHref, usd } from "@/lib/format";
import { pageMetadata } from "@/lib/seo";
import { datasetLd, organizationLd, websiteLd } from "@/lib/structured-data";
import { plural } from "@/lib/site";
import { JsonLd } from "./json-ld";
import { Card, DivergingSplit, SectionTitle } from "./charts";
import { ActionBadge, Amount, BUTTON, MoneyText, PartyBadge, TickerChip } from "./ui";
import { MemberAvatar } from "./avatar";
import { GroupedList, LIST_FOOT_LINK, ROW_LINK } from "./grouped-list";
import { IntervalBar, Points, intervalText } from "./track-ui";
import { LiveRelativeTime } from "./live-relative-time";
import { SignalsAndConvergence } from "./signals";
import { AlertsCta } from "./account-client";
import { Quiet } from "./page-header";
import { ChevronRight } from "lucide-react";

/**
 * The landing page. What the site is, in one screen, then the evidence:
 * what is happening right now, both sources side by side (never summed),
 * whose trades were followed by the biggest moves, where members agree, and
 * how alerts reach you. The live feed itself is `/feed`.
 */

export const dynamic = "force-dynamic";

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
    description: `${lead}, plus SEC Form 4 corporate insider trades, with free email alerts. Amounts are shown as the ranges filed, never as invented exact figures.`,
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

export default async function HomePage() {
  const [pipeline, insiderTotals] = await Promise.all([
    getPipeline().catch(() => null),
    getInsiderTotals().catch(() => null),
  ]);

  return (
    <div className="space-y-16 sm:space-y-24">
      <SiteStructuredData />
      <Hero
        trades={pipeline?.totals.transactions ?? null}
        members={pipeline?.totals.members ?? null}
        insiderTrades={insiderTotals?.trades ?? null}
        issuers={insiderTotals?.issuers ?? null}
        updatedAt={pipeline?.lastUpdated ?? null}
      />
      <SignalsAndConvergence />
      <TwoSources />
      <TrackRecords />
      <Consensus />
      <HowAlertsWork />
    </div>
  );
}

/* ------------------------------------------------------------------ hero */

function Hero({
  trades,
  members,
  insiderTrades,
  issuers,
  updatedAt,
}: {
  trades: number | null;
  members: number | null;
  insiderTrades: number | null;
  issuers: number | null;
  updatedAt: string | null;
}) {
  const figures = [
    trades != null ? { value: trades.toLocaleString("en-US"), label: "congressional trades" } : null,
    members != null ? { value: members.toLocaleString("en-US"), label: "members of Congress" } : null,
    insiderTrades != null ? { value: insiderTrades.toLocaleString("en-US"), label: "corporate insider trades" } : null,
    issuers != null ? { value: issuers.toLocaleString("en-US"), label: "companies" } : null,
  ].filter((f): f is { value: string; label: string } => f != null);

  return (
    <section className="apple-headline-reveal pt-2 text-center sm:pt-8">
      <p className="inline-flex items-center gap-2 rounded-full bg-fill/85 px-3 py-1 text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
        <span className="size-1.5 rounded-full bg-ok motion-safe:animate-pulse" aria-hidden />
        Updated <LiveRelativeTime iso={updatedAt} initial={relativeTime(updatedAt)} />
      </p>
      <h1 className="mx-auto mt-5 max-w-[16ch] text-balance text-[40px] font-bold leading-[1.04] tracking-[-0.035em] text-foreground sm:text-[64px]">
        See what Congress and insiders are trading.
      </h1>
      <p className="mx-auto mt-5 max-w-[40rem] text-pretty text-[17px] leading-relaxed text-ink-2 sm:text-[21px]">
        Every stock trade members of Congress disclose under the STOCK Act, and every large open-market trade
        company insiders file with the SEC. Reproduced as filed, searchable, and in your inbox when it matters.
      </p>
      <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
        <AlertsCta from="home_hero" />
        <a href="/feed" className={`${BUTTON} h-11 px-6 text-[15px]`}>
          Browse the live feed
        </a>
      </div>
      {figures.length ? (
        <dl className="mx-auto mt-12 grid max-w-[52rem] grid-cols-2 gap-x-6 gap-y-6 sm:grid-cols-4">
          {figures.map((f) => (
            <div key={f.label}>
              <dt className="sr-only">{f.label}</dt>
              <dd>
                <span className="tabular block text-[28px] font-semibold tracking-[-0.02em] text-foreground sm:text-[34px]">
                  {f.value}
                </span>
                <span className="text-[13px] text-muted-foreground">{f.label}</span>
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </section>
  );
}

/* ----------------------------------------------------------- two sources */

const LATEST = 6;
/** Rows read to find LATEST filings: one filing can hold dozens of trades. */
const ROWS_READ = 300;

/** Rows grouped into filings, in the order the rows arrive (newest filing first). */
function byFiling<T>(rows: T[], key: (r: T) => string, limit: number): T[][] {
  const groups = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    const g = groups.get(k);
    if (g) g.push(r);
    else if (groups.size < limit) groups.set(k, [r]);
  }
  return [...groups.values()];
}

async function TwoSources() {
  const [congress, insiders] = await Promise.all([
    // Newest disclosure first, dated by filing: a trade date as filed can be
    // mistyped into the future, and would otherwise sit at the top for months.
    getTransactions({ order: "filed", limit: ROWS_READ }).catch(() => [] as TransactionRow[]),
    getInsiderTrades({ order: "filed", limit: ROWS_READ }).catch(() => [] as InsiderTradeRow[]),
  ]);
  const congressFilings = byFiling(congress, (r) => r.doc_id, LATEST);
  const insiderFilings = byFiling(insiders, (r) => r.accession, LATEST);
  return (
    <section className="grid gap-8 lg:grid-cols-2 lg:gap-5">
      <div className="flex min-w-0 flex-col [&>:last-child]:flex-1">
        <SectionTitle kicker="STOCK Act · House & Senate" right={<span className="text-muted-foreground">newest filings</span>}>
          Congress
        </SectionTitle>
        <GroupedList
          footer={
            <a href="/feed" className={LIST_FOOT_LINK}>
              The live feed
              <ChevronRight aria-hidden className="size-3.5" strokeWidth={2.25} />
            </a>
          }
        >
          {congressFilings.length ? (
            congressFilings.map((rows) => <CongressFiling key={rows[0].doc_id} rows={rows} />)
          ) : (
            <li className="px-5 py-4">
              <Quiet>No trades yet.</Quiet>
            </li>
          )}
        </GroupedList>
      </div>
      <div className="flex min-w-0 flex-col [&>:last-child]:flex-1">
        <SectionTitle kicker="SEC Form 4 · officers & directors" right={<span className="text-muted-foreground">newest filings</span>}>
          Corporate insiders
        </SectionTitle>
        <GroupedList
          footer={
            <a href="/insiders" className={LIST_FOOT_LINK}>
              Insider activity
              <ChevronRight aria-hidden className="size-3.5" strokeWidth={2.25} />
            </a>
          }
        >
          {insiderFilings.length ? (
            insiderFilings.map((rows) => <InsiderFiling key={rows[0].accession} rows={rows} />)
          ) : (
            <li className="px-5 py-4">
              <Quiet>No insider trades yet.</Quiet>
            </li>
          )}
        </GroupedList>
      </div>
    </section>
  );
}

const ROW = "px-4 py-3 transition-colors duration-(--dur-fast) hover:bg-[var(--feed-hover)] sm:px-5";
const CHIPS_SHOWN = 4;

/**
 * One congressional filing: each direction once with what was traded that
 * way, and the amount only when it is a single trade (brackets are not
 * added up here).
 */
function CongressFiling({ rows }: { rows: TransactionRow[] }) {
  const r = rows[0];
  // Each direction once, then what was traded that way.
  const sides = new Map<string, { key: string; ticker: string | null; label: string }[]>();
  for (const x of rows) {
    const list = sides.get(x.action) ?? [];
    const key = x.ticker ?? x.asset_name;
    if (!list.some((i) => i.key === key)) list.push({ key, ticker: x.ticker, label: assetLabel(x.asset_name, { ticker: null }) });
    sides.set(x.action, list);
  }
  return (
    <li className={ROW}>
      <div className="flex items-center gap-2.5">
        <MemberAvatar name={r.member_name} bioguideId={r.bioguide_id} size="sm" />
        <a href={memberHref(r.member_name, r.bioguide_id)} className={`${ROW_LINK} min-w-0 truncate`}>
          {memberLabel(r.member_name, null, r.state, r.district, r.chamber)}
        </a>
        <PartyBadge party={r.party} />
        <span className="flex-1" />
        <span className="tabular shrink-0 text-[12px] text-muted-foreground">filed {shortDate(r.filing_date)}</span>
      </div>
      <div className="mt-1.5 space-y-1.5 pl-[34px]">
        {[...sides.entries()].map(([action, items]) => (
          <div key={action} className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1.5">
            <ActionBadge action={action} />
            {items.slice(0, CHIPS_SHOWN).map((i) =>
              i.ticker ? (
                <TickerChip key={i.key} ticker={i.ticker} href={tickerHref(i.ticker)} />
              ) : (
                <span key={i.key} className="max-w-[16rem] truncate text-[13px] text-ink-2">
                  {i.label}
                </span>
              )
            )}
            {items.length > CHIPS_SHOWN ? (
              <span className="text-[12.5px] text-muted-foreground">+{items.length - CHIPS_SHOWN} more</span>
            ) : null}
          </div>
        ))}
        <p className="text-[12.5px] text-muted-foreground">
          {rows.length === 1 ? (
            <span className="font-medium text-ink-2">
              <Amount min={r.amount_min_cents} max={r.amount_max_cents} exact={r.amount_exact_cents} />
            </span>
          ) : (
            plural(rows.length, "trade")
          )}
        </p>
      </div>
    </li>
  );
}

/**
 * One Form 4. Per direction: the trades and their value (shares × reported
 * price, summed within this one filing). A direction with an unpriced or
 * implausible row says its sum is partial; one with no priced row has none.
 */
function InsiderFiling({ rows }: { rows: InsiderTradeRow[] }) {
  const r = rows[0];
  const sides = (["purchase", "sale"] as const)
    .map((action) => {
      const these = rows.filter((x) => x.action === action);
      const priced = these.filter((x) => x.implausible !== 1 && x.amount_exact_cents != null);
      return {
        action,
        n: these.length,
        cents: priced.length ? priced.reduce((sum, x) => sum + (x.amount_exact_cents ?? 0), 0) : null,
        partial: priced.length > 0 && priced.length < these.length,
      };
    })
    .filter((side) => side.n > 0);
  return (
    <li className={ROW}>
      <div className="flex items-center gap-2.5">
        <span className="min-w-0 truncate text-[14px] font-semibold text-foreground">{r.insider_name ?? "Unknown filer"}</span>
        <span className="min-w-0 truncate text-[13px] text-muted-foreground">{r.issuer_name}</span>
        <span className="flex-1" />
        <span className="tabular shrink-0 text-[12px] text-muted-foreground">filed {shortDate(r.filing_date)}</span>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1.5">
        {r.ticker ? <TickerChip ticker={r.ticker} href={insiderIssuerHref(r.ticker)} /> : null}
        {sides.map((side) => (
          <span key={side.action} className="inline-flex items-center gap-1.5">
            <ActionBadge action={side.action} />
            <span className="tabular text-[13px] text-ink-2" title="shares × reported price, summed within this filing">
              {side.cents != null ? (
                <span className="font-medium">
                  {side.partial ? "≥" : ""}
                  <MoneyText value={usd(side.cents)} />
                </span>
              ) : (
                "no value"
              )}
              {side.n > 1 ? <span className="text-muted-foreground"> · {plural(side.n, "trade")}</span> : null}
            </span>
          </span>
        ))}
      </div>
    </li>
  );
}

/* --------------------------------------------------------- track records */

async function TrackRecords() {
  let ranked: TrackScoreRow[] = [];
  try {
    const board = await getTrackLeaderboard(90);
    ranked = board.available ? board.ranked.slice(0, 5) : [];
  } catch {
    return null;
  }
  if (!ranked.length) return null;
  const scale = Math.max(...ranked.flatMap((r) => [Math.abs(r.trade.lo ?? 0), Math.abs(r.trade.hi ?? 0), Math.abs(r.trade.score)]), 0.01);
  return (
    <section>
      <SectionTitle
        kicker="Track record · 90 trading days"
        right={
          <a href="/politicians?view=track" className="ink-link text-[13px]">
            Full ranking →
          </a>
        }
      >
        Whose trades were followed by the biggest moves
      </SectionTitle>
      <p className="mb-4 max-w-[68ch] text-[14px] leading-relaxed text-muted-foreground">
        How the stocks each member traded moved over the next 90 trading days against the S&amp;P 500, read the way
        the trade pointed. A stock&apos;s move, not anyone&apos;s profit, and not evidence of wrongdoing. The bar is a 90%
        interval: one that crosses the line cannot be told apart from no edge.
      </p>
      <GroupedList>
        {ranked.map((r) => (
          <li key={r.member_name} className={`${ROW} grid grid-cols-[1.5rem_minmax(0,1fr)_auto] items-center gap-x-3 sm:grid-cols-[1.5rem_minmax(0,22rem)_minmax(8rem,1fr)_5.5rem]`}>
            <span className="tabular text-[13px] text-muted-foreground">{r.rank}</span>
            <span className="flex min-w-0 items-center gap-2.5">
              <MemberAvatar name={r.member_name} bioguideId={r.bioguide_id} size="sm" />
              <a href={memberHref(r.member_name, r.bioguide_id)} className={`${ROW_LINK} min-w-0 truncate`}>
                {memberLabel(r.member_name, null, r.state, r.district, r.chamber)}
              </a>
              <PartyBadge party={r.party} />
            </span>
            <IntervalBar
              className="hidden sm:block"
              score={r.trade.score}
              lo={r.trade.lo}
              hi={r.trade.hi}
              scale={scale}
              label={`${points(r.trade.score)} points, 90% interval ${intervalText(r.trade.lo, r.trade.hi)}`}
            />
            <span className="text-right text-[15px] font-semibold">
              <Points value={r.trade.score} />
              <span className="block text-[11.5px] font-normal text-muted-foreground">{plural(r.n, "decision")}</span>
            </span>
          </li>
        ))}
      </GroupedList>
    </section>
  );
}

/* -------------------------------------------------------------- consensus */

async function Consensus() {
  const consensus = await getConsensusTickers(90, 6).catch(() => []);
  if (!consensus.length) return null;
  return (
    <section>
      <SectionTitle kicker="Bipartisan activity" right={<span className="text-muted-foreground">Last 90 days</span>}>
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
  );
}

/* ------------------------------------------------------- how alerts work */

const STEPS = [
  {
    icon: Star,
    title: "Follow members and stocks",
    body: "One tap on any member or ticker page. Your follows live on your account, on every device.",
  },
  {
    icon: Mail,
    title: "Get one email a day",
    body: "When anything you follow files a new trade, a single morning digest. Nothing on quiet days.",
  },
  {
    icon: Users,
    title: "Catch the clusters",
    body: "Optional alerts when several members, or several insiders, trade the same stock the same way.",
  },
];

function HowAlertsWork() {
  return (
    <section className="tile apple-card-reveal px-6 py-10 text-center sm:px-12 sm:py-14">
      <Bell className="mx-auto size-7 text-foreground" strokeWidth={1.8} aria-hidden />
      <h2 className="mx-auto mt-4 max-w-[20ch] text-balance text-[30px] font-bold leading-tight tracking-[-0.03em] sm:text-[40px]">
        Alerts that come to you.
      </h2>
      <p className="mx-auto mt-3 max-w-[36rem] text-[16px] leading-relaxed text-ink-2 sm:text-[17px]">
        Free. No password: sign in with Google or a link by email.
      </p>
      <div className="mx-auto mt-10 grid max-w-[56rem] gap-8 text-left sm:grid-cols-3">
        {STEPS.map(({ icon: Icon, title, body }) => (
          <div key={title}>
            <span className="flex size-10 items-center justify-center rounded-full bg-fill">
              <Icon className="size-[18px] text-foreground" strokeWidth={2} aria-hidden />
            </span>
            <p className="mt-3 text-[16px] font-semibold text-foreground">{title}</p>
            <p className="mt-1 text-[14px] leading-relaxed text-muted-foreground">{body}</p>
          </div>
        ))}
      </div>
      <div className="mt-10">
        <AlertsCta from="home_alerts" />
      </div>
    </section>
  );
}
