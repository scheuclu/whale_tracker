import { assetLabel } from "@/lib/asset-label";
import { getBothSides, getSharedTickers, type BothSidesRow, type SharedTickers } from "@/lib/crossover-queries";
import { COUNT_NOUN, KIND_LABEL, getAlerts, isInsiderKind, type AlertKind, type AlertRow } from "@/lib/alert-queries";
import { insiderIssuerHref, memberHref, range, relativeTime, tickerHref, usd } from "@/lib/format";
import { Card, SectionTitle } from "./charts";
import { ActionBadge, MoneyText, PartyBadge, Tag, TickerChip } from "./ui";
import { Disclosure } from "./disclosure";
import { Quiet } from "./page-header";
import { GroupedList, LIST_FOOT_LINK, ROW_LINK } from "./grouped-list";
import { GetAlertsPopover } from "./watchlist-client";
import { ChevronRight } from "lucide-react";

/**
 * The landing page's "right now" pair: the latest alerts sent, and tickers
 * Congress and corporate insiders traded the same way in the last 30 days.
 * Moved here from the feed when `/` became the landing page.
 */

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
export async function SignalsAndConvergence() {
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
                      href={isInsiderKind(a.kind) ? insiderIssuerHref(a.ticker) : undefined}
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
                  href={insiderIssuerHref(r.ticker)}
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
