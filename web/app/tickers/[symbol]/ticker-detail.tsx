import { getTickerMembers, getTransactions, type TickerMemberRow, type TickerRow, type TransactionRow } from "@/lib/queries";
import { getInsiderTrades, getIssuerInsiders, type InsiderTradeRow, type IssuerInsiderRow, type IssuerRow } from "@/lib/insider-queries";
import { ASSET_TYPE_LABEL, memberHref, memberLabel, range, shortDate, tickerHref, usd } from "@/lib/format";
import { Card, SectionTitle, VolumeRange } from "../../charts";
import { ExportLink } from "../../feed-controls";
import { PLAIN_BODY_ROW, PLAIN_HEAD_ROW } from "../../sortable-table";
import { ActionBadge, Amount, BUTTON, MoneyText, OptionBadge, OwnerTag, ResponsiveTable, RoleTag, SectorTag, Tag } from "../../ui";
import { TradeList, TradeRow } from "../../trade-row";
import { getTimelineTrades, type TimelineTrade } from "@/lib/timeline-queries";
import { TradeTimeline } from "../../timeline";
import { PriceOverlay } from "../../price-overlay";

import { TickerMembers } from "../ticker-members";
import { AgentAlternates } from "../../agent-alternates";
import { assetLabel } from "@/lib/asset-label";
import { Disclosure, RangeCaption } from "../../disclosure";
import { BackLink, DataError, PAGE_STACK, Quiet } from "../../page-header";
import { ShareControl } from "../../share-control";
import { FollowButton, GetAlertsPopover } from "../../watchlist-client";
import { absoluteUrl, plural } from "@/lib/site";
import { longDate } from "@/lib/members";
import { cn } from "@/lib/utils";
import { MemberAvatar } from "../../avatar";
import { DirectionSplit } from "../../politicians/member-hero";
import { SymbolHero } from "../../symbol-hero";
import { GroupedList, ROW_LINK, ValueRow } from "../../grouped-list";
import { InsiderTradeList } from "../../insider-trade-list";
import { isWatchTicker } from "@/lib/watchlist";
import { ChevronRight } from "lucide-react";

/*
 * One ticker's page, `/tickers/<SYMBOL>`. Moved out of app/tickers/page.tsx
 * when the ticker view got its own URL.
 */

/** The page body; the route looks up both aggregates first, since its
 *  metadata and 404 need the same rows. */
export async function StockDetail({
  symbol,
  stat,
  issuer,
}: {
  symbol: string;
  /** Congressional aggregate; null when no member has traded the symbol. */
  stat: TickerRow | null;
  /** Form 4 aggregate; null when no insider filing carries the symbol. */
  issuer: IssuerRow | null;
}) {
  const ticker = symbol;
  // Caught like every other detail page: uncaught, a failed fetch threw out
  // of the server component instead of rendering the data-error state.
  let trades: TransactionRow[], optionTrades: TransactionRow[], timeline: TimelineTrade[], members: TickerMemberRow[];
  let insiders: IssuerInsiderRow[], insiderTrades: InsiderTradeRow[];
  try {
    [trades, optionTrades, timeline, members, insiders, insiderTrades] = await Promise.all([
      stat ? getTransactions({ ticker, limit: 200 }) : [],
      stat ? getTransactions({ ticker, options: true, limit: 500 }) : [],
      stat ? getTimelineTrades({ ticker }) : [],
      stat ? getTickerMembers(ticker, undefined, 1000) : [],
      issuer ? getIssuerInsiders(ticker).catch(() => []) : [],
      issuer ? getInsiderTrades({ ticker, limit: 200 }).catch(() => []) : [],
    ]);
  } catch (err) {
    return <DataError error={err} />;
  }

  const calls = optionTrades.filter((r) => r.option_kind === "call").length;
  const puts = optionTrades.filter((r) => r.option_kind === "put").length;
  const assetTypes = assetTypeMix(timeline);
  const sector = trades[0] ?? insiderTrades[0];
  const company = stat?.asset_name ?? issuer?.issuer_name ?? null;
  const lastTraded = [stat?.last_tx_date, issuer?.last_tx_date].filter((d): d is string => !!d).sort().pop() ?? null;
  const summary = [
    stat ? plural(stat.politicians, "member") + " of Congress" : null,
    issuer ? plural(issuer.insiders, "corporate insider") : null,
  ].filter(Boolean);
  const watchable = isWatchTicker(ticker);

  return (
    <div className={PAGE_STACK}>
      {stat ? <AgentAlternates ticker={ticker} /> : null}
      <header className="space-y-8 sm:space-y-10">
        <div className="mb-3 flex items-center justify-between sm:mb-4">
          <BackLink href="/tickers" label="Stocks" />
        </div>
        <SymbolHero
          symbol={ticker}
          identity={company ? <span title={company}>{assetLabel(company, { ticker })}</span> : null}
          badges={
            assetTypes.length || sector?.industry_group ? (
              <>
                {assetTypes.map((a) => (
                  <Tag key={a.code} title={`${a.count} of ${timeline.length} congressional trades filed with asset type ${a.code}`}>
                    {a.label}
                  </Tag>
                ))}
                <SectorTag group={sector?.industry_group} sic={sector?.sic} description={sector?.sic_description} />
              </>
            ) : null
          }
          summary={<>Traded by {summary.join(" and ")}.</>}
          facts={lastTraded ? `last traded ${longDate(lastTraded)}` : null}
          actions={
            <>
              {watchable ? (
                <>
                  <FollowButton kind="ticker" id={ticker} label={ticker} />
                  <GetAlertsPopover subject={{ kind: "ticker", id: ticker, label: ticker }} />
                </>
              ) : null}
              <ShareControl
                url={absoluteUrl(tickerHref(ticker))}
                text={`${ticker}: stock trades by ${stat && issuer ? "members of Congress and corporate insiders" : stat ? "members of Congress" : "corporate insiders"}`}
              />
            </>
          }
        />
        {/* The two sources side by side, each in its own terms, never added together. */}
        <section aria-label="Who trades it" className="grid gap-3 sm:gap-4 lg:grid-cols-2">
          <CongressLane ticker={ticker} stat={stat} members={members} />
          <InsiderLane ticker={ticker} issuer={issuer} insiders={insiders} />
        </section>
      </header>

      <PriceOverlay ticker={ticker} focus={stat ? "congress" : "insider"} congress={stat ? timeline : undefined} />

      {stat ? (
        <section id="congress" className="table-anchor space-y-10">
          <SectionHead
            kicker="STOCK Act · House & Senate"
            title="Congress"
            note="Every amount is the bracket a member disclosed; volumes add brackets up and are estimates."
          />
          <section>
            <SectionTitle kicker="Chronology" right={<span className="text-muted-foreground">By trade date</span>}>
              Trades over time
            </SectionTitle>
            <TradeTimeline trades={timeline} mode="ticker" />
          </section>

          <section>
            <SectionTitle kicker="Bracket Interval">Disclosed volume range</SectionTitle>
            <Card>
              <VolumeRange
                min={stat.volume_min}
                max={stat.volume_max}
                mid={stat.volume_mid}
                scaleMax={stat.volume_max ?? stat.volume_min * 2}
              />
              <RangeCaption />
            </Card>
          </section>

          <TickerMembers ticker={stat.ticker} members={members} />

          <section>
            <SectionTitle kicker="Complete Ledger" right={<ExportLink filters={{ ticker }} />}>Every disclosed trade</SectionTitle>
            <TradeList>
              {trades.map((r) => (
                <TradeRow key={r.id} r={r} subject="member" />
              ))}
            </TradeList>
          </section>

      {optionTrades.length ? (
        <section>
          <SectionTitle
            kicker="Derivatives"
            right={
              <span>
                {calls} call{calls === 1 ? "" : "s"} · {puts} put{puts === 1 ? "" : "s"}
              </span>
            }
          >
            Options
          </SectionTitle>
          <ResponsiveTable>
            <table className="w-full text-[13px]">
              <thead>
                <tr className={PLAIN_HEAD_ROW}>
                  <th className="px-4 py-2.5 font-medium">Contract</th>
                  <th className="px-4 py-2.5 font-medium">Action</th>
                  <th className="px-4 py-2.5 font-medium">Member</th>
                  <th className="px-4 py-2.5 text-right font-medium">Disclosed range</th>
                  <th className="px-4 py-2.5 text-right font-medium">Traded</th>
                  <th className="px-4 py-2.5 text-right font-medium">Expires</th>
                  <th className="px-4 py-2.5 text-right font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {optionTrades.map((r) => (
                  <tr key={r.id} className={PLAIN_BODY_ROW}>
                    <td className="px-4 py-2">
                      <OptionBadge kind={r.option_kind} strikeCents={r.strike_cents} expiry={null} />
                    </td>
                    <td className="px-4 py-2">
                      <ActionBadge action={r.action} />
                    </td>
                    <td className="px-4 py-2">
                      <a href={memberHref(r.member_name, r.bioguide_id)} className="font-medium hover:text-primary">
                        {memberLabel(r.member_name, r.party, r.state, r.district, r.chamber)}
                      </a>
                      <OwnerTag owner={r.owner} />
                    </td>
                    <td className="tabular px-4 py-2 text-right">
                      <Amount min={r.amount_min_cents} max={r.amount_max_cents} exact={r.amount_exact_cents} />
                    </td>
                    <td className="tabular px-4 py-2 text-right text-muted-foreground">{shortDate(r.tx_date)}</td>
                    <td className="tabular px-4 py-2 text-right text-muted-foreground">
                      {r.expiry ? shortDate(r.expiry) : <span title="The filing did not print an expiry">—</span>}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <a
                        href={r.pdf_url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-[11px] text-muted-foreground underline-offset-2 hover:text-primary hover:underline"
                      >
                        filing
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ResponsiveTable>
          <Disclosure
            size="sm"
            className="mt-3"
            lead="Kind, strike and expiry are read from each filing’s own text and shown only when printed; amounts are the disclosed brackets."
          >
            <p>A put bought is listed as the purchase it was filed as.</p>
          </Disclosure>
        </section>
      ) : null}
        </section>
      ) : null}

      {issuer ? (
        <section id="insiders" className="table-anchor space-y-10">
          <SectionHead
            kicker="SEC Form 4 · officers, directors & 10% owners"
            title="Corporate insiders"
            note={`Open-market buys and sells by ${issuer.issuer_name ?? ticker}'s own insiders, from filings of $50k or more in one direction. Values are shares × reported price, never added to the congressional figures.`}
          />
          <section>
            <SectionTitle kicker="Corporate Filers" right={<span>{plural(insiders.length, "insider")} · shares × reported price</span>}>
              Who traded
            </SectionTitle>
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
            <SectionTitle kicker="Complete Ledger">Every stored insider trade</SectionTitle>
            <Disclosure
              size="sm"
              className="mb-3 pl-1"
              lead="Values are shares × the price as filed; a filer may report a weighted average."
            >
              <p>A row whose as-filed value is implausible is shown as filed and counted in no total.</p>
            </Disclosure>
            <InsiderTradeList trades={insiderTrades} showIssuer={false} />
          </section>
        </section>
      ) : null}
    </div>
  );
}

/** A source's heading on the stock page: big, with the one caveat that governs its figures. */
function SectionHead({ kicker, title, note }: { kicker: string; title: string; note: string }) {
  return (
    <div className="border-t border-border pt-8">
      <p className="apple-section-kicker mb-1">{kicker}</p>
      <h2 className="display text-[30px] leading-tight tracking-[-0.03em] text-foreground sm:text-[40px]">{title}</h2>
      <p className="mt-2 max-w-[68ch] text-[14px] leading-relaxed text-muted-foreground">{note}</p>
    </div>
  );
}

const LANE = "tile apple-card-reveal flex flex-col gap-4 p-5 sm:px-6 sm:py-5";
const LANE_LINK =
  "mt-auto inline-flex w-fit items-center gap-1 text-[13px] font-medium text-ink-2 underline decoration-border-strong underline-offset-[3px] hover:text-foreground";

/**
 * One figure in a lane. Marked `data-stat-tile` with StatTile's label/value
 * nesting, so e2e/data-rules.spec.ts holds it to the same rule: a single
 * dollar figure says "est." or "shares × reported price".
 */
function LaneFigure({ label, value, hint }: { label: string; value: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <div data-stat-tile className="min-w-0">
      <div>
        <div className="text-[12px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">{label}</div>
      </div>
      <div>
        <div className="tabular mt-0.5 truncate text-[22px] font-semibold tracking-[-0.02em] text-foreground">{value}</div>
        {hint ? <div className="text-[12px] leading-snug text-muted-foreground">{hint}</div> : null}
      </div>
    </div>
  );
}

/** The congressional side at a glance: disclosed brackets, estimates labelled. */
function CongressLane({ ticker, stat, members }: { ticker: string; stat: TickerRow | null; members: TickerMemberRow[] }) {
  if (!stat) {
    return (
      <div className={cn(LANE, "lg:self-start")}>
        <p className="apple-section-kicker">Congress · STOCK Act</p>
        <Quiet>No member of Congress has disclosed a trade in {ticker}.</Quiet>
      </div>
    );
  }
  const top = [...members].sort((a, b) => b.trades - a.trades || b.volume_mid - a.volume_mid).slice(0, 3);
  return (
    <div className={LANE}>
      <p className="apple-section-kicker">Congress · STOCK Act</p>
      <div className="grid grid-cols-3 gap-3">
        <LaneFigure label="Members" value={stat.politicians} />
        <LaneFigure label="Trades" value={stat.trades} hint={`last ${shortDate(stat.last_tx_date)}`} />
        <LaneFigure
          label="Volume (est.)"
          value={<MoneyText value={usd(stat.volume_mid)} />}
          hint={<>disclosed <MoneyText value={range(stat.volume_min, stat.volume_max)} /></>}
        />
      </div>
      <DirectionSplit
        buys={stat.buys}
        sells={stat.sells}
        exchanges={stat.trades - stat.buys - stat.sells}
        buyers={stat.buy_politicians}
        sellers={stat.sell_politicians}
      />
      {top.length ? (
        <div className="flex flex-wrap items-center gap-1.5 text-[12.5px]">
          <span className="mr-1 font-semibold">Most active</span>
          {top.map((m) => (
            <a
              key={m.member_name}
              href={memberHref(m.member_name, m.bioguide_id)}
              className={cn(BUTTON, "h-7 gap-1.5 pl-1 pr-3 text-[12.5px]")}
              title={`${m.trades} trade${m.trades === 1 ? "" : "s"} in ${ticker}`}
            >
              <MemberAvatar name={m.member_name} bioguideId={m.bioguide_id} size="xs" />
              {m.member_name}
            </a>
          ))}
        </div>
      ) : null}
      <a href="#congress" className={LANE_LINK}>
        Congressional trades <ChevronRight aria-hidden className="size-3.5" />
      </a>
    </div>
  );
}

/** The Form 4 side at a glance: shares × reported price, primary owners. */
function InsiderLane({ ticker, issuer, insiders }: { ticker: string; issuer: IssuerRow | null; insiders: IssuerInsiderRow[] }) {
  if (!issuer) {
    return (
      <div className={cn(LANE, "lg:self-start")}>
        <p className="apple-section-kicker">Corporate insiders · SEC Form 4</p>
        <Quiet>No stored open-market Form 4 trade in {ticker} (filings of $50k or more in one direction).</Quiet>
      </div>
    );
  }
  const top = [...insiders].sort((a, b) => b.bought + b.sold - (a.bought + a.sold)).slice(0, 3);
  const value = (v: number, unpriced: number) => (v ? <MoneyText value={usd(v)} /> : unpriced ? "unpriced" : "—");
  return (
    <div className={LANE}>
      <p className="apple-section-kicker">Corporate insiders · SEC Form 4</p>
      <div className="grid grid-cols-3 gap-3">
        <LaneFigure
          label="Insiders"
          value={issuer.insiders}
          hint={`${plural(issuer.filings, "filing")} · last ${shortDate(issuer.last_tx_date)}`}
        />
        <LaneFigure label="Bought" value={value(issuer.buy_value, issuer.unpriced_buys)} hint="shares × reported price" />
        <LaneFigure label="Sold" value={value(issuer.sell_value, issuer.unpriced_sells)} hint="shares × reported price" />
      </div>
      <DirectionSplit buys={issuer.buys} sells={issuer.sells} buyers={issuer.buy_insiders} sellers={issuer.sell_insiders} noun="insider" />
      {top.length ? (
        <div className="flex flex-wrap items-center gap-1.5 text-[12.5px]">
          <span className="mr-1 font-semibold">Largest</span>
          {top.map((p) => (
            <a
              key={p.cik}
              href={`/insiders?cik=${encodeURIComponent(p.cik)}`}
              className={cn(BUTTON, "h-7 px-3 text-[12.5px]")}
              title={`${p.buys} buy / ${p.sells} sell · shares × reported price`}
            >
              {p.name}
            </a>
          ))}
        </div>
      ) : null}
      <a href="#insiders" className={LANE_LINK}>
        Insider trades <ChevronRight aria-hidden className="size-3.5" />
      </a>
    </div>
  );
}

/**
 * The asset types this symbol was filed under, most common first — "Stock",
 * then "Options" when members also traded contracts on it. A code the
 * Clerk's list does not name is shown as filed.
 */
function assetTypeMix(rows: TimelineTrade[]): { code: string; label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const r of rows) if (r.asset_type) counts.set(r.asset_type, (counts.get(r.asset_type) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([code, count]) => ({ code, label: ASSET_TYPE_LABEL[code] ?? code, count }));
}

