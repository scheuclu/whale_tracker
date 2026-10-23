import { getTickerMembers, getTransactions, type TickerRow } from "@/lib/queries";
import { getInsiderIssuer, getIssuerInsiders, type IssuerInsiderRow, type IssuerRow } from "@/lib/insider-queries";
import { ASSET_TYPE_LABEL, memberHref, memberLabel, range, shortDate, tickerHref, usd } from "@/lib/format";
import { Card, Empty, SectionTitle, StatTile, VolumeRange } from "../../charts";
import { ExportLink } from "../../feed-controls";
import { PLAIN_BODY_ROW, PLAIN_HEAD_ROW } from "../../sortable-table";
import { ActionBadge, Amount, BUTTON, OptionBadge, OwnerTag, ResponsiveTable, RoleTag, SectorTag, Tag } from "../../ui";
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
import { absoluteUrl, plural } from "@/lib/site";
import { longDate, tradeSummary } from "@/lib/members";
import { cn } from "@/lib/utils";
import { MemberAvatar } from "../../avatar";
import { DirectionSplit, GlanceTile } from "../../politicians/member-hero";
import { SymbolHero } from "../../symbol-hero";
import { GROUPED_ROW, GroupedList, LIST_FOOT_LINK, ROW_LINK } from "../../grouped-list";
import { ChevronRight } from "lucide-react";

/*
 * One ticker's page, `/tickers/<SYMBOL>`. Moved out of app/tickers/page.tsx
 * when the ticker view got its own URL.
 */

/** The page body; the route looks up `stat` first, since its metadata and
 *  404 need the same row. */
export async function TickerDetail({ stat }: { stat: TickerRow }) {
  const ticker = stat.ticker;
  // Caught like every other detail page: uncaught, a failed fetch threw out
  // of the server component instead of rendering the data-error state.
  let trades, optionTrades, timeline, members;
  try {
    [trades, optionTrades, timeline, members] = await Promise.all([
      getTransactions({ ticker, limit: 200 }),
      getTransactions({ ticker, options: true, limit: 500 }),
      getTimelineTrades({ ticker }),
      getTickerMembers(ticker, undefined, 1000),
    ]);
  } catch (err) {
    return <DataError error={err} />;
  }

  const scaleMax = stat.volume_max ?? stat.volume_min * 2;
  const calls = optionTrades.filter((r) => r.option_kind === "call").length;
  const puts = optionTrades.filter((r) => r.option_kind === "put").length;
  const assetTypes = assetTypeMix(timeline);
  const disclosed = range(stat.volume_min, stat.volume_max);
  const other = stat.trades - stat.buys - stat.sells;
  // The three members with the most trades in it, for the glance tile.
  const topMembers = [...members].sort((a, b) => b.trades - a.trades || b.volume_mid - a.volume_mid).slice(0, 3);

  return (
    <div className={PAGE_STACK}>
      <AgentAlternates ticker={ticker} />
      <header className="space-y-8 sm:space-y-10">
        <div className="-mb-2 flex items-center justify-between sm:-mb-4">
          <BackLink href="/tickers" label="Tickers" />
        </div>
        <SymbolHero
          symbol={stat.ticker}
          identity={
            <span title={stat.asset_name ?? undefined}>{assetLabel(stat.asset_name, { ticker: stat.ticker })}</span>
          }
          badges={
            assetTypes.length || trades[0]?.industry_group ? (
              <>
                {assetTypes.map((a) => (
                  <Tag key={a.code} title={`${a.count} of ${timeline.length} trades filed with asset type ${a.code}`}>
                    {a.label}
                  </Tag>
                ))}
                <SectorTag
                  group={trades[0]?.industry_group}
                  sic={trades[0]?.sic}
                  description={trades[0]?.sic_description}
                />
              </>
            ) : null
          }
          summary={<>{tradeSummary({ trades: stat.trades, tickers: 0, buys: stat.buys, sells: stat.sells }, plural(stat.politicians, "member"))}.</>}
          facts={stat.last_tx_date ? `last traded ${longDate(stat.last_tx_date)}` : null}
          actions={
            <ShareControl url={absoluteUrl(tickerHref(ticker))} text={`${ticker}: stock trades disclosed by members of Congress`} />
          }
        />
        <div className="space-y-3 sm:space-y-4">
          <section aria-label="Ticker totals" className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
            <StatTile label="Members" value={String(stat.politicians)} hint="distinct filers" />
            <StatTile label="Trades" value={String(stat.trades)} hint={`${stat.buys} buy / ${stat.sells} sell`} />
            <StatTile
              label="Volume (est.)"
              value={usd(stat.volume_mid)}
              hint={
                stat.transcribed
                  ? `disclosed ${disclosed} · ${stat.transcribed} transcribed not counted`
                  : `disclosed ${disclosed}`
              }
            />
            <StatTile label="Last trade" value={shortDate(stat.last_tx_date)} />
          </section>
          <GlanceTile
            aside={
              topMembers.length ? (
                <>
                  <span className="mr-1 font-semibold">Most active</span>
                  {topMembers.map((m) => (
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
                </>
              ) : null
            }
          >
            <DirectionSplit
              buys={stat.buys}
              sells={stat.sells}
              exchanges={other}
              buyers={stat.buy_politicians}
              sellers={stat.sell_politicians}
            />
          </GlanceTile>
        </div>
      </header>

      <PriceOverlay ticker={ticker} focus="congress" congress={timeline} />

      <section>
        <SectionTitle right={<span className="text-muted-foreground">By trade date</span>}>
          Trades over time
        </SectionTitle>
        <TradeTimeline trades={timeline} mode="ticker" />
      </section>

      <section>
        <SectionTitle>Disclosed volume range</SectionTitle>
        <Card>
          <VolumeRange
            min={stat.volume_min}
            max={stat.volume_max}
            mid={stat.volume_mid}
            scaleMax={scaleMax}
          />
          <RangeCaption />
        </Card>
      </section>

      <TickerMembers ticker={stat.ticker} members={members} />

      <section>
        <SectionTitle right={<ExportLink filters={{ ticker }} />}>Every disclosed trade</SectionTitle>
        <TradeList>
          {trades.map((r) => (
            <TradeRow key={r.id} r={r} subject="member" />
          ))}
        </TradeList>
      </section>

      <InsidersInIssuer ticker={ticker} />

      {optionTrades.length ? (
        <section>
          <SectionTitle
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

/** Trade-date window for the cross-link, matching the insider page's own 90d view. */
const CROSS_WINDOW_DAYS = 90;

/**
 * The SEC Form 4 side of this symbol, set beside the member figures and never
 * added to them: distinct primary reporting owners, values as shares × the
 * price as filed rather than a disclosed range. Fetches its own data so a
 * fault in the insider tables cannot take the congressional page down.
 */
async function InsidersInIssuer({ ticker }: { ticker: string }) {
  let issuer: IssuerRow | null, owners: IssuerInsiderRow[], allTime: IssuerRow | null;
  try {
    [issuer, owners, allTime] = await Promise.all([
      getInsiderIssuer(ticker, CROSS_WINDOW_DAYS),
      getIssuerInsiders(ticker, CROSS_WINDOW_DAYS),
      getInsiderIssuer(ticker),
    ]);
  } catch (err) {
    return (
      <section>
        <SectionTitle>Insiders in this issuer</SectionTitle>
        <DataError error={err} context="Insider data unavailable" />
      </section>
    );
  }
  const href = `/insiders?t=${encodeURIComponent(ticker)}`;

  return (
    <section>
      <SectionTitle
        right={
          <span>last {CROSS_WINDOW_DAYS} days · SEC Form 4</span>
        }
      >
        Insiders in this issuer
      </SectionTitle>
      {issuer ? (
        <GroupedList
          header={
            <p className="text-[14px] leading-relaxed text-ink-2">
              <span className="font-semibold text-foreground">{plural(issuer.insiders, "insider")}</span> of{" "}
              {issuer.issuer_name ?? ticker} filed {plural(issuer.filings, "Form 4")} —{" "}
              {[
                issuer.buy_insiders
                  ? `${issuer.buy_insiders} bought${issuer.buy_value ? ` ${usd(issuer.buy_value)}` : ""}`
                  : null,
                issuer.sell_insiders
                  ? `${issuer.sell_insiders} sold${issuer.sell_value ? ` ${usd(issuer.sell_value)}` : ""}`
                  : null,
              ]
                .filter(Boolean)
                .join(", ")}
              <span className="text-muted-foreground"> · last trade {shortDate(issuer.last_tx_date)}</span>
            </p>
          }
          footer={
            <>
              <Disclosure
                size="sm"
                lead="Values are shares × the price as filed, not a disclosed range. Kept apart from the member figures above — nothing here enters them."
              >
                <p>Primary reporting owners from stored Form 4s.</p>
              </Disclosure>
              <a href={href} className={LIST_FOOT_LINK}>
                Every stored insider trade in {ticker}
                <ChevronRight aria-hidden className="size-3.5" strokeWidth={2.25} />
              </a>
            </>
          }
        >
          {owners.map((p) => (
            <li key={p.cik} className={GROUPED_ROW}>
              <a href={`/insiders?cik=${encodeURIComponent(p.cik)}`} className={ROW_LINK}>
                {p.name}
              </a>
              <RoleTag
                isDirector={p.is_director}
                isOfficer={p.is_officer}
                isTenPercentOwner={p.is_ten_percent_owner}
                officerTitle={p.officer_title}
              />
              <div className="flex-1" />
              <span className="tabular text-[13px] text-muted-foreground">
                {p.buys} buy / {p.sells} sell
              </span>
              <span className="tabular min-w-24 text-right text-[13px]">
                {p.bought ? `+${usd(p.bought)}` : ""}
                {p.bought && p.sold ? " " : ""}
                {p.sold ? `−${usd(p.sold)}` : ""}
              </span>
            </li>
          ))}
        </GroupedList>
      ) : (
        <Card>
          <Quiet>
            No stored Form 4 trade in {ticker} in the last {CROSS_WINDOW_DAYS} days.{" "}
            {allTime ? (
              <>
                {plural(allTime.trades, "trade")} stored all-time —{" "}
                <a href={href} className="ink-link">
                  see the issuer
                </a>
                .
              </>
            ) : (
              "No stored filing carries this symbol."
            )}
          </Quiet>
        </Card>
      )}
    </section>
  );
}
