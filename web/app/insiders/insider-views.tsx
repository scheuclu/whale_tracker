import { ChevronRight } from "lucide-react";
import {
  INSIDER_TRACK_HORIZONS,
  getInsiderFiler,
  getInsiderFilerIssuers,
  getInsiderFilerTrack,
  getInsiderFilers,
  getInsiderTrackLeaderboard,
  getInsiderTrades,
  type InsiderFilerRow,
  type InsiderTrackHorizon,
  type InsiderTrackScoreRow,
  type InsiderTradeRow,
} from "@/lib/insider-queries";
import { TRACK_BENCHMARK, percent, points } from "@/lib/track-queries";
import { insiderIssuerHref, price, shares, shortDate, usd } from "@/lib/format";
import { longDate, tradeSummary } from "@/lib/members";
import { Card, Empty, SectionTitle, StatTile } from "../charts";
import {
  ActionBadge,
  Amount,
  BUTTON,
  InsiderDelayTag,
  PlanTag,
  ResponsiveTable,
  RoleTag,
  SectorTag,
  Segmented,
  StatusNote,
  Tag,
  TickerChip,
} from "../ui";
import { MemberAvatar } from "../avatar";
import { Disclosure } from "../disclosure";
import { BackLink, DataError, PAGE_STACK, PageHeader, PillLinks, Quiet } from "../page-header";
import { GroupedList, LIST_FOOT_LINK, ROW_LINK, ValueRow } from "../grouped-list";
import { DirectionSplit, GlanceTile } from "../politicians/member-hero";
import { BODY_ROW, DATA_TABLE, HEAD_ROW, PlainHeader } from "../sortable-table";
import { RowLinkBody, StickyThead } from "../table-client";
import { FollowButton, GetAlertsPopover } from "../watchlist-client";
import { ShareControl } from "../share-control";
import { SymbolMark } from "../symbol-hero";
import { absoluteUrl, plural } from "@/lib/site";
import { cn } from "@/lib/utils";

function HeaderCell({
  children,
  align = "left",
  hint,
  className,
}: {
  children?: React.ReactNode;
  align?: "left" | "right";
  hint?: string;
  className?: string;
}) {
  return (
    <PlainHeader align={align} className={className}>
      <span title={hint} className={cn(hint && "underline decoration-dotted decoration-muted-foreground/40 underline-offset-[4px]")}>
        {children}
      </span>
    </PlainHeader>
  );
}

export function insiderFilerHref(cik: string): string {
  return `/insiders?cik=${encodeURIComponent(cik)}`;
}

function MoveVal({ value, strong }: { value: number | null | undefined; strong?: boolean }) {
  if (value == null) return <span className="text-muted-foreground">—</span>;
  return (
    <span className={cn("tabular", strong && "font-semibold text-foreground")}>
      {points(value)} pts
    </span>
  );
}

/**
 * Showcase card on `/insiders` surfacing high-conviction open-market buyers
 * (C-suite officers, directors, and 10% owners) with one-click Follow and
 * profile links.
 */
export function TopInsiderBuyersSection({
  buyers,
  scoredTop,
}: {
  buyers: InsiderFilerRow[];
  scoredTop: InsiderTrackScoreRow[];
}) {
  const scoreByCik = new Map(scoredTop.map((s) => [s.cik, s]));
  if (buyers.length === 0) return null;

  return (
    <section>
      <SectionTitle
        kicker="Corporate Filer Profiles & Ratings"
        right={
          <a href="/insiders?view=track" className="ink-link text-[13px]">
            Full ratings &amp; track record →
          </a>
        }
      >
        High-conviction open-market buyers
      </SectionTitle>
      <GroupedList
        inset="3.25rem"
        header={
          <div className="flex flex-wrap items-center justify-between gap-2 text-[13.5px] text-ink-2">
            <span>
              Primary reporting owners ranked by open-market purchase value (<strong className="font-medium text-foreground">shares × reported price</strong>). Click any filer to inspect their track record vs {TRACK_BENCHMARK} and follow their filings.
            </span>
          </div>
        }
        footer={
          <a href="/insiders?view=track" className={LIST_FOOT_LINK}>
            Compare all rated corporate insiders &amp; post-trade moves vs {TRACK_BENCHMARK}
            <ChevronRight aria-hidden className="size-3.5" strokeWidth={2.25} />
          </a>
        }
      >
        {buyers.slice(0, 8).map((f) => {
          const track = scoreByCik.get(f.cik);
          const discretionaryShare =
            f.trades > 0 ? Math.round(((f.trades - f.plan_trades) / f.trades) * 100) : 100;
          return (
            <li
              key={f.cik}
              className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3 transition-colors duration-(--dur-fast) hover:bg-[var(--feed-hover)] sm:px-5"
            >
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <MemberAvatar name={f.name} size="md" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <a href={insiderFilerHref(f.cik)} className={cn(ROW_LINK, "truncate")}>
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
                  <p className="mt-0.5 text-[12.5px] text-muted-foreground">
                    {plural(f.buys, "open-market buy")} across {plural(f.filings, "Form 4")} ·{" "}
                    {discretionaryShare}% discretionary (non-10b5-1)
                    {track ? (
                      <span className="text-foreground">
                        {" "}
                        · <strong>{points(track.trade_score)} pts</strong> vs {TRACK_BENCHMARK} ({track.horizon}d)
                      </span>
                    ) : null}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <div className="text-right">
                  <p className="tabular text-[14px] font-semibold text-foreground">
                    +{usd(f.buy_value)}
                  </p>
                  <p className="text-[11.5px] text-muted-foreground">shares × reported price</p>
                </div>
                <FollowButton kind="insider" id={f.cik} label={f.name} />
              </div>
            </li>
          );
        })}
      </GroupedList>
    </section>
  );
}

/**
 * `/insiders?view=track` — Post-trade stock moves against the S&P 500 (SPY)
 * after corporate insiders' SEC Form 4 decisions, plus high-conviction
 * C-suite and 10%-owner buyer rankings.
 */
export async function InsiderTrackView({
  horizon,
  role,
}: {
  horizon: InsiderTrackHorizon;
  role?: string;
}) {
  const roleFilter =
    role === "officer" || role === "director" || role === "ten_percent" ? role : "all";

  let board, buyers;
  try {
    [board, buyers] = await Promise.all([
      getInsiderTrackLeaderboard(horizon),
      getInsiderFilers({
        role: roleFilter === "all" ? undefined : roleFilter,
        direction: "buy",
        limit: 40,
      }),
    ]);
  } catch (err) {
    return <DataError error={err} />;
  }

  const horizonHref = (h: InsiderTrackHorizon) => {
    const q = new URLSearchParams({ view: "track" });
    if (h !== 20) q.set("h", String(h));
    if (roleFilter !== "all") q.set("role", roleFilter);
    return `/insiders?${q.toString()}`;
  };

  const roleHref = (r: string) => {
    const q = new URLSearchParams({ view: "track" });
    if (horizon !== 20) q.set("h", String(horizon));
    if (r !== "all") q.set("role", r);
    return `/insiders?${q.toString()}`;
  };

  const filteredTrackRows = board.rows.filter((r) => {
    if (roleFilter === "officer") return r.is_officer === 1;
    if (roleFilter === "director") return r.is_director === 1;
    if (roleFilter === "ten_percent") return r.is_ten_percent_owner === 1;
    return true;
  });

  return (
    <div className={PAGE_STACK}>
      <PageHeader
        eyebrow="Corporate Insiders · Ratings & Track Record"
        title="Insider track record & conviction"
        subtitle={`How the stock moved against the S&P 500 (${TRACK_BENCHMARK}) in the ${horizon} trading days after each corporate insider’s SEC Form 4 decision, alongside open-market purchase conviction.`}
        aside={
          <div className="flex flex-wrap items-center gap-2">
            <Segmented
              label="Insiders view"
              items={[
                { key: "overview", href: "/insiders", label: "Overview & Issuers", active: false },
                { key: "track", href: "/insiders?view=track", label: "Ratings & Track Record", active: true },
              ]}
            />
            <Segmented
              label="Horizon"
              items={INSIDER_TRACK_HORIZONS.map((h) => ({
                key: String(h),
                href: horizonHref(h),
                label: `${h} trading days`,
                active: h === horizon,
              }))}
            />
          </div>
        }
      >
        <section
          aria-label="Insider track record summary"
          className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4"
        >
          <StatTile
            label="Decisions measured"
            value={board.decisions_measured.toLocaleString()}
            hint={`across ${board.insiders_scored.toLocaleString()} insiders at ${horizon}d`}
          />
          <StatTile
            label="After the trade"
            value={board.mean_trade != null ? `${points(board.mean_trade)} pts` : "—"}
            hint={`mean vs ${TRACK_BENCHMARK} over ${horizon}d`}
          />
          <StatTile
            label="After Form 4 filing"
            value={board.mean_disclosure != null ? `${points(board.mean_disclosure)} pts` : "—"}
            hint={`mean vs ${TRACK_BENCHMARK} after SEC disclosure`}
          />
          <StatTile
            label="Open-market buyers"
            value={buyers.length.toLocaleString()}
            hint="ranked by shares × reported price"
          />
        </section>
      </PageHeader>

      <Card>
        <Disclosure
          lead={`Each decision is one corporate insider’s open-market purchase or sale on SEC Form 4, compared with ${TRACK_BENCHMARK} over the next ${horizon} trading days.`}
        >
          <p>
            A purchase is read the way the insider traded (the stock’s return minus {TRACK_BENCHMARK}’s);
            a sale is read with the sign flipped, so selling before a drop against {TRACK_BENCHMARK} is positive.
            Scores are shrunk toward zero (`n / (n + 2)`) so a single lucky trade does not dominate a repeat buyer.
          </p>
          <p>
            Unlike congressional periodic transaction reports (which can take up to 45 days), SEC Form 4 is due
            within two business days, so the post-trade and post-filing clocks sit close together.
            This is the stock’s move after the filing, not anyone’s realized profit and not investment advice.
          </p>
        </Disclosure>
      </Card>

      <PillLinks
        label="Role filter"
        note="narrows both tables below by corporate relationship on Form 4"
        items={[
          { key: "all", label: "All roles" },
          { key: "officer", label: "C-Suite & Officers" },
          { key: "director", label: "Directors" },
          { key: "ten_percent", label: "10% Owners" },
        ].map((item) => ({
          href: roleHref(item.key),
          label: item.label,
          active: roleFilter === item.key,
        }))}
      />

      <section id="track-ranked" className="table-anchor">
        <SectionTitle
          kicker="Post-Trade Performance vs S&P 500"
          right={
            <span>
              {plural(filteredTrackRows.length, "insider")} scored over {horizon} trading days
            </span>
          }
        >
          Ranked by post-trade move vs {TRACK_BENCHMARK} ({horizon}d)
        </SectionTitle>
        {filteredTrackRows.length ? (
          <ResponsiveTable>
            <table className={DATA_TABLE}>
              <StickyThead>
                <tr className={HEAD_ROW}>
                  <HeaderCell align="right" hint="Rank by shrunk post-trade excess move vs SPY.">
                    #
                  </HeaderCell>
                  <HeaderCell align="left">Insider &amp; Issuer</HeaderCell>
                  <HeaderCell
                    align="right"
                    hint={`Shrunk mean excess return vs ${TRACK_BENCHMARK} over ${horizon} trading days after the trade date, in percentage points.`}
                  >
                    After the trade
                  </HeaderCell>
                  <HeaderCell
                    align="right"
                    hint="Raw mean excess move before shrinkage."
                  >
                    Raw mean
                  </HeaderCell>
                  <HeaderCell
                    align="right"
                    hint={`Share of measured decisions that beat ${TRACK_BENCHMARK} in the trade’s direction.`}
                  >
                    Hit rate
                  </HeaderCell>
                  <HeaderCell
                    align="right"
                    hint="Measured trade-date decisions (buys / sells) across stored Form 4 filings."
                  >
                    Decisions
                  </HeaderCell>
                  <HeaderCell
                    align="right"
                    hint={`Mean move vs ${TRACK_BENCHMARK} over ${horizon} trading days starting the first session after the Form 4 filing date.`}
                  >
                    After filing
                  </HeaderCell>
                  <HeaderCell
                    align="right"
                    hint="Total value of measured decisions (shares × reported price)."
                  >
                    Value (shares × price)
                  </HeaderCell>
                  <HeaderCell align="right">Follow</HeaderCell>
                </tr>
              </StickyThead>
              <RowLinkBody>
                {filteredTrackRows.slice(0, 60).map((r) => (
                  <tr
                    key={r.cik}
                    className={BODY_ROW}
                    data-href={insiderFilerHref(r.cik)}
                  >
                    <td className="tabular px-3 py-2.5 text-right text-muted-foreground">
                      {r.rank}
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <a href={insiderFilerHref(r.cik)} className="row-name">
                          {r.name}
                        </a>
                        <TickerChip ticker={r.primary_ticker} href={insiderIssuerHref(r.primary_ticker)} />
                        <RoleTag
                          isDirector={r.is_director}
                          isOfficer={r.is_officer}
                          isTenPercentOwner={r.is_ten_percent_owner}
                          officerTitle={r.officer_title}
                        />
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <MoveVal value={r.trade_score} strong />
                    </td>
                    <td className="px-3 py-2.5 text-right text-muted-foreground">
                      <MoveVal value={r.trade_mean} />
                    </td>
                    <td className="tabular px-3 py-2.5 text-right">
                      {percent(r.hit_rate)}
                    </td>
                    <td className="tabular px-3 py-2.5 text-right text-muted-foreground">
                      {r.n} <span className="text-[11.5px]">({r.buys}B/{r.sells}S)</span>
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <MoveVal value={r.disclosure_mean} />
                    </td>
                    <td className="tabular px-3 py-2.5 text-right font-medium">
                      {r.value_cents ? usd(r.value_cents) : "—"}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <FollowButton kind="insider" id={r.cik} label={r.name} />
                    </td>
                  </tr>
                ))}
              </RowLinkBody>
            </table>
          </ResponsiveTable>
        ) : (
          <Quiet>No scored corporate insiders match this role filter.</Quiet>
        )}
      </section>

      <section id="conviction-buyers" className="table-anchor">
        <SectionTitle
          kicker="Open-Market Purchase Conviction"
          right={<span>ranked by shares × reported price</span>}
        >
          Largest open-market buyers on SEC Form 4
        </SectionTitle>
        {buyers.length ? (
          <ResponsiveTable>
            <table className={DATA_TABLE}>
              <StickyThead>
                <tr className={HEAD_ROW}>
                  <HeaderCell align="left">Insider</HeaderCell>
                  <HeaderCell align="left">Primary issuer</HeaderCell>
                  <HeaderCell align="right" hint="Stored Form 4 filings.">
                    Filings
                  </HeaderCell>
                  <HeaderCell align="right" hint="Open-market purchases / sales.">
                    Buys / sells
                  </HeaderCell>
                  <HeaderCell
                    align="right"
                    hint="Share of trades NOT marked as executed under a Rule 10b5-1 pre-arranged trading plan."
                  >
                    Discretionary
                  </HeaderCell>
                  <HeaderCell
                    align="right"
                    hint="Total open-market purchase value (shares × reported price)."
                  >
                    Bought (shares × price)
                  </HeaderCell>
                  <HeaderCell align="right">Last trade</HeaderCell>
                  <HeaderCell align="right">Follow</HeaderCell>
                </tr>
              </StickyThead>
              <RowLinkBody>
                {buyers.map((f) => {
                  const discPct =
                    f.trades > 0 ? Math.round(((f.trades - f.plan_trades) / f.trades) * 100) : 100;
                  return (
                    <tr
                      key={f.cik}
                      className={BODY_ROW}
                      data-href={insiderFilerHref(f.cik)}
                    >
                      <td className="px-3 py-2.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <a href={insiderFilerHref(f.cik)} className="row-name">
                            {f.name}
                          </a>
                          <RoleTag
                            isDirector={f.is_director}
                            isOfficer={f.is_officer}
                            isTenPercentOwner={f.is_ten_percent_owner}
                            officerTitle={f.officer_title}
                          />
                        </div>
                      </td>
                      <td className="px-3 py-2.5">
                        {f.primary_ticker ? (
                          <TickerChip ticker={f.primary_ticker} href={insiderIssuerHref(f.primary_ticker)} />
                        ) : (
                          <span className="text-muted-foreground">{f.primary_issuer_name ?? "—"}</span>
                        )}
                      </td>
                      <td className="tabular px-3 py-2.5 text-right text-muted-foreground">
                        {f.filings}
                      </td>
                      <td className="tabular px-3 py-2.5 text-right">
                        {f.buys} / {f.sells}
                      </td>
                      <td className="tabular px-3 py-2.5 text-right text-muted-foreground">
                        {discPct}%
                      </td>
                      <td className="tabular px-3 py-2.5 text-right font-semibold text-foreground">
                        {usd(f.buy_value)}
                      </td>
                      <td className="tabular px-3 py-2.5 text-right text-muted-foreground">
                        {shortDate(f.last_tx_date)}
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <FollowButton kind="insider" id={f.cik} label={f.name} />
                      </td>
                    </tr>
                  );
                })}
              </RowLinkBody>
            </table>
          </ResponsiveTable>
        ) : (
          <Quiet>No open-market buyers match this role filter.</Quiet>
        )}
      </section>
    </div>
  );
}

/**
 * `/insiders?cik=<CIK>` — Full profile page for an individual corporate insider
 * (`owner_index = 0` on SEC Form 4), including Follow/Alert actions, post-trade
 * track record vs SPY, issuers traded, and every stored Form 4 transaction.
 */
export async function InsiderFilerDetail({
  cik,
  action,
}: {
  cik: string;
  action?: string;
}) {
  const cleanCik = cik.trim();
  let filer, issuers, track, trades;
  try {
    [filer, issuers, track, trades] = await Promise.all([
      getInsiderFiler(cleanCik),
      getInsiderFilerIssuers(cleanCik),
      getInsiderFilerTrack(cleanCik),
      getInsiderTrades({ cik: cleanCik, action, limit: 200 }),
    ]);
  } catch (err) {
    return <DataError error={err} />;
  }

  if (!filer) {
    return (
      <div className={PAGE_STACK}>
        <BackLink href="/insiders" label="Insiders" />
        <Empty>No stored SEC Form 4 filings for CIK {cleanCik}.</Empty>
      </div>
    );
  }

  const discretionaryPct =
    filer.trades > 0 ? Math.round(((filer.trades - filer.plan_trades) / filer.trades) * 100) : 100;
  const onTimePct =
    filer.trades > 0 ? Math.round(((filer.trades - filer.late_trades) / filer.trades) * 100) : 100;

  return (
    <div className={PAGE_STACK}>
      <header className="space-y-8 sm:space-y-10">
        <div className="-mb-2 flex items-center justify-between sm:-mb-4">
          <BackLink href="/insiders" label="Insiders" />
          <a href="/insiders?view=track" className="ink-link text-[13px]">
            Insider ratings &amp; leaderboard →
          </a>
        </div>

        <div className="rounded-[24px] bg-card p-6 shadow-card ring-1 ring-black/[0.04] dark:ring-white/[0.07] sm:p-8">
          <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex items-start gap-4">
              <MemberAvatar name={filer.name} size="lg" />
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Tag>SEC Form 4 Filer</Tag>
                  <RoleTag
                    isDirector={filer.is_director}
                    isOfficer={filer.is_officer}
                    isTenPercentOwner={filer.is_ten_percent_owner}
                    officerTitle={filer.officer_title}
                  />
                  <span className="font-mono text-[12px] text-muted-foreground">CIK {filer.cik}</span>
                </div>
                <h1 className="mt-1.5 text-[clamp(1.625rem,3vw,2.25rem)] font-bold leading-[1.08] tracking-[-0.03em] text-foreground">
                  {filer.name}
                </h1>
                <p className="mt-1.5 text-[14.5px] leading-relaxed text-ink-2">
                  {tradeSummary(
                    {
                      trades: filer.trades,
                      tickers: filer.issuers,
                      buys: filer.buys,
                      sells: filer.sells,
                    },
                    filer.name
                  )}
                  .
                </p>
                <p className="mt-1 text-[13px] text-muted-foreground">
                  {plural(filer.filings, "Form 4 filing")} · {discretionaryPct}% discretionary (non-10b5-1) ·{" "}
                  {onTimePct}% filed within 2 business days
                  {filer.last_tx_date ? ` · last traded ${longDate(filer.last_tx_date)}` : ""}
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <FollowButton kind="insider" id={filer.cik} label={filer.name} />
              <GetAlertsPopover
                subject={{ kind: "insider", id: filer.cik, label: filer.name }}
              />
              <ShareControl
                url={absoluteUrl(insiderFilerHref(filer.cik))}
                text={`${filer.name} (CIK ${filer.cik}): SEC Form 4 corporate insider trades`}
              />
            </div>
          </div>
        </div>

        <div className="space-y-3 sm:space-y-4">
          <section
            aria-label="Insider filer totals"
            className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4"
          >
            <StatTile
              label="Trades"
              value={filer.trades.toLocaleString()}
              hint={`${filer.buys} buy / ${filer.sells} sell across ${plural(filer.filings, "Form 4")}`}
            />
            <StatTile
              label="Bought"
              value={filer.buy_value ? usd(filer.buy_value) : "—"}
              hint="shares × reported price"
            />
            <StatTile
              label="Sold"
              value={filer.sell_value ? usd(filer.sell_value) : "—"}
              hint="shares × reported price"
            />
            <StatTile
              label="Conviction & timeliness"
              value={`${discretionaryPct}%`}
              hint={`discretionary · ${onTimePct}% on-time`}
            />
          </section>

          <GlanceTile
            aside={
              issuers.length ? (
                <>
                  <span className="mr-1 font-semibold">Issuers</span>
                  {issuers.slice(0, 4).map((iss) =>
                    iss.ticker ? (
                      <TickerChip
                        key={iss.issuer_cik}
                        ticker={iss.ticker}
                        href={insiderIssuerHref(iss.ticker)}
                      />
                    ) : null
                  )}
                </>
              ) : null
            }
          >
            <DirectionSplit
              buys={filer.buys}
              sells={filer.sells}
              buyers={filer.buys > 0 ? 1 : 0}
              sellers={filer.sells > 0 ? 1 : 0}
              noun="filer"
            />
          </GlanceTile>
        </div>
      </header>

      <section id="track-record" className="table-anchor">
        <SectionTitle
          kicker="Post-Trade Performance vs S&P 500"
          right={
            <a href="/insiders?view=track" className="ink-link text-[13px]">
              All scored insiders →
            </a>
          }
        >
          Track record vs {TRACK_BENCHMARK}
        </SectionTitle>
        {track.available && (track.score5 || track.score20) ? (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
              <StatTile
                label="5-day move (shrunk)"
                value={track.score5 ? `${points(track.score5.trade_score)} pts` : "—"}
                hint={
                  track.score5
                    ? `raw ${points(track.score5.trade_mean)} pts across ${plural(track.score5.n, "decision")}`
                    : "waiting for 5 trading days"
                }
              />
              <StatTile
                label="5-day hit rate"
                value={track.score5 ? percent(track.score5.hit_rate) : "—"}
                hint={`beat ${TRACK_BENCHMARK} in trade’s direction`}
              />
              <StatTile
                label="20-day move (shrunk)"
                value={track.score20 ? `${points(track.score20.trade_score)} pts` : "—"}
                hint={
                  track.score20
                    ? `raw ${points(track.score20.trade_mean)} pts across ${plural(track.score20.n, "decision")}`
                    : "waiting for 20 trading days"
                }
              />
              <StatTile
                label="20-day hit rate"
                value={track.score20 ? percent(track.score20.hit_rate) : "—"}
                hint={`beat ${TRACK_BENCHMARK} over 20 sessions`}
              />
            </div>

            <ResponsiveTable>
              <table className={DATA_TABLE}>
                <StickyThead>
                  <tr className={HEAD_ROW}>
                    <HeaderCell align="left">Ticker</HeaderCell>
                    <HeaderCell align="left">Direction</HeaderCell>
                    <HeaderCell align="right">Trade date</HeaderCell>
                    <HeaderCell align="right">Filing date</HeaderCell>
                    <HeaderCell align="right" hint="Shares × reported price.">
                      Value (shares × price)
                    </HeaderCell>
                    <HeaderCell align="right" hint={`Signed excess return vs ${TRACK_BENCHMARK} 5 trading days after trade.`}>
                      5d vs {TRACK_BENCHMARK}
                    </HeaderCell>
                    <HeaderCell align="right" hint={`Signed excess return vs ${TRACK_BENCHMARK} 20 trading days after trade.`}>
                      20d vs {TRACK_BENCHMARK}
                    </HeaderCell>
                  </tr>
                </StickyThead>
                <tbody>
                  {track.decisions.map((d) => (
                    <tr key={`${d.filing_id}:${d.tx_date}:${d.direction}`} className={BODY_ROW}>
                      <td className="px-3 py-2.5">
                        <TickerChip ticker={d.ticker} href={insiderIssuerHref(d.ticker)} />
                      </td>
                      <td className="px-3 py-2.5">
                        <ActionBadge action={d.direction === "buy" ? "purchase" : "sale"} />
                      </td>
                      <td className="tabular px-3 py-2.5 text-right text-muted-foreground">
                        {shortDate(d.tx_date)}
                      </td>
                      <td className="tabular px-3 py-2.5 text-right text-muted-foreground">
                        {shortDate(d.filing_date)}
                      </td>
                      <td className="tabular px-3 py-2.5 text-right font-medium">
                        {d.value_cents ? usd(d.value_cents) : "—"}
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <MoveVal value={d.signed_trade_5} strong />
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <MoveVal value={d.signed_trade_20} strong />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ResponsiveTable>
          </div>
        ) : (
          <Card>
            <Quiet>
              Post-trade moves vs {TRACK_BENCHMARK} are still maturing for {filer.name}’s recent filings (or the issuer’s price series is not in the benchmarked set yet).
            </Quiet>
          </Card>
        )}
      </section>

      {issuers.length > 0 ? (
        <section>
          <SectionTitle
            kicker="Companies Traded"
            right={<span>{plural(issuers.length, "issuer")} · shares × reported price</span>}
          >
            Issuers on SEC Form 4
          </SectionTitle>
          <GroupedList>
            {issuers.map((iss) => (
              <ValueRow
                key={iss.issuer_cik}
                name={
                  iss.ticker ? (
                    <a
                      href={insiderIssuerHref(iss.ticker)}
                      className={cn(ROW_LINK, "inline-flex items-center gap-2")}
                    >
                      <SymbolMark symbol={iss.ticker} size="sm" />
                      <span>{iss.ticker}</span>
                      {iss.issuer_name ? (
                        <span className="font-normal text-muted-foreground">· {iss.issuer_name}</span>
                      ) : null}
                    </a>
                  ) : (
                    <span className="font-semibold">{iss.issuer_name ?? iss.issuer_cik}</span>
                  )
                }
                tags={
                  <RoleTag
                    isDirector={iss.is_director}
                    isOfficer={iss.is_officer}
                    isTenPercentOwner={iss.is_ten_percent_owner}
                    officerTitle={iss.officer_title}
                  />
                }
                value={
                  <>
                    {iss.buy_value ? `+${usd(iss.buy_value)}` : ""}
                    {iss.buy_value && iss.sell_value ? " " : ""}
                    {iss.sell_value ? `−${usd(iss.sell_value)}` : ""}
                  </>
                }
                meta={`${iss.buys} buy / ${iss.sells} sell · ${plural(iss.filings, "filing")}`}
              />
            ))}
          </GroupedList>
        </section>
      ) : null}

      <section>
        <SectionTitle
          kicker="Complete Ledger"
          right={
            <PillLinks
              label="Direction"
              items={[
                { k: undefined, label: "All" },
                { k: "buy", label: "Buys" },
                { k: "sell", label: "Sells" },
              ].map((f) => ({
                href: f.k
                  ? `${insiderFilerHref(filer.cik)}&action=${f.k}`
                  : insiderFilerHref(filer.cik),
                label: f.label,
                active: (action ?? undefined) === f.k,
              }))}
            />
          }
        >
          Every stored Form 4 trade
        </SectionTitle>
        {trades.length ? (
          <GroupedList>
            {trades.map((r: InsiderTradeRow) => (
              <li
                key={r.id}
                className="px-4 py-3 transition-colors duration-(--dur-fast) hover:bg-[var(--feed-hover)] sm:px-5"
              >
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
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
                <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-muted-foreground">
                  <span>{r.issuer_name ?? r.security_title ?? "common stock"}</span>
                  {r.direct_or_indirect === "I" && r.nature_of_ownership ? (
                    <span>· {r.nature_of_ownership}</span>
                  ) : null}
                  <a
                    href={r.source_url}
                    target="_blank"
                    rel="noreferrer"
                    className="ml-auto rounded-sm text-[12px] text-muted-foreground underline decoration-border-strong underline-offset-[3px] hover:text-foreground"
                  >
                    filing<span aria-hidden>&nbsp;↗</span>
                  </a>
                </div>
              </li>
            ))}
          </GroupedList>
        ) : (
          <Quiet>No trades match this filter.</Quiet>
        )}
      </section>
    </div>
  );
}
