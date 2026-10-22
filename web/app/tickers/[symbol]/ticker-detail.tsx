import { getTickerMembers, getTransactions, type TickerRow } from "@/lib/queries";
import { getInsiderIssuer, getIssuerInsiders, type IssuerInsiderRow, type IssuerRow } from "@/lib/insider-queries";
import { ASSET_TYPE_LABEL, memberHref, memberLabel, range, shortDate, tickerHref, usd } from "@/lib/format";
import { Card, Empty, SectionTitle, StatTile, VolumeRange } from "../../charts";
import { ExportLink } from "../../feed-controls";
import { ActionBadge, Amount, OptionBadge, OwnerTag, ResponsiveTable, RoleTag, SectorTag } from "../../ui";
import { TradeList, TradeRow } from "../../trade-row";
import { getTimelineTrades, type TimelineTrade } from "@/lib/timeline-queries";
import { TradeTimeline } from "../../timeline";

import { TickerMembers } from "../ticker-members";
import { AgentAlternates } from "../../agent-alternates";
import { assetLabel } from "@/lib/asset-label";
import { Disclosure, RangeCaption } from "../../disclosure";
import { DataError, PAGE_STACK, PageHeader, Quiet } from "../../page-header";
import { ShareControl } from "../../share-control";
import { absoluteUrl } from "@/lib/site";

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

  return (
    <div className={PAGE_STACK}>
      <AgentAlternates ticker={ticker} />
      <PageHeader
        back={{ href: "/tickers", label: "all tickers" }}
        share={<ShareControl url={absoluteUrl(tickerHref(ticker))} text={`${ticker}: stock trades disclosed by members of Congress`} />}
        title={stat.ticker}
        titleClassName="font-mono sm:text-[44px]"
        badges={
          <>
              {assetTypes.map((a) => (
                <span
                  key={a.code}
                  className="rounded-md border border-border px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
                  title={`${a.count} of ${timeline.length} trades filed with asset type ${a.code}`}
                >
                  {a.label}
                </span>
              ))}
              <SectorTag
                group={trades[0]?.industry_group}
                sic={trades[0]?.sic}
                description={trades[0]?.sic_description}
              />
          </>
        }
        subtitle={
          <span className="text-ink-2" title={stat.asset_name ?? undefined}>
            {assetLabel(stat.asset_name, { ticker: stat.ticker })}
          </span>
        }
        aside={
          <FlowSplit
            buys={stat.buys}
            sells={stat.sells}
            other={other}
            buyers={stat.buy_politicians}
            sellers={stat.sell_politicians}
          />
        }
      >
      <section aria-label="Ticker totals" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
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
      </PageHeader>

      <section>
        <SectionTitle right={<span className="text-[11px] text-muted-foreground">by trade date</span>}>
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
              <span className="text-[11px] text-muted-foreground">
                {calls} call{calls === 1 ? "" : "s"} · {puts} put{puts === 1 ? "" : "s"}
              </span>
            }
          >
            Options
          </SectionTitle>
          <ResponsiveTable>
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-border text-left text-[11px] uppercase tracking-[0.06em] text-muted-foreground">
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
                  <tr key={r.id} className="border-b border-border/50 last:border-0 hover:bg-muted/50">
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

/**
 * Buys against sells as one split bar — trade counts, not money, so it is
 * exact. Two fills with a 2px surface gap; both counts and directions are
 * spelled out beside it, so the colour pair never carries the meaning
 * alone. Exchanges and other actions are named, not drawn.
 */
function FlowSplit({
  buys,
  sells,
  other,
  buyers,
  sellers,
}: {
  buys: number;
  sells: number;
  other: number;
  buyers: number;
  sellers: number;
}) {
  const total = buys + sells;
  if (!total) return null;
  return (
    <div
      className="w-full sm:w-72"
      role="img"
      aria-label={`${buys} buys by ${buyers} members, ${sells} sells by ${sellers} members`}
    >
      <div className="mb-1.5 flex items-baseline justify-between text-[11px] text-muted-foreground">
        <span>
          <span className="text-sm font-semibold text-foreground">{buys}</span> bought
        </span>
        <span>
          sold <span className="text-sm font-semibold text-foreground">{sells}</span>
        </span>
      </div>
      <div className="flex h-2.5 gap-0.5">
        {buys ? (
          <div
            className="h-full"
            style={{
              width: `${(buys / total) * 100}%`,
              background: "var(--viz-buy)",
              borderRadius: sells ? "4px 2px 2px 4px" : "4px",
            }}
          />
        ) : null}
        {sells ? (
          <div
            className="h-full flex-1"
            style={{ background: "var(--viz-sell)", borderRadius: buys ? "2px 4px 4px 2px" : "4px" }}
          />
        ) : null}
      </div>
      <div className="mt-1.5 flex justify-between text-[11px] text-muted-foreground">
        <span>
          by {buyers} member{buyers === 1 ? "" : "s"}
        </span>
        <span>
          {other ? `${other} other · ` : ""}by {sellers} member{sellers === 1 ? "" : "s"}
        </span>
      </div>
    </div>
  );
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
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

  return (
    <section>
      <SectionTitle
        right={
          <span className="text-[11px] text-muted-foreground">
            last {CROSS_WINDOW_DAYS} days · SEC Form 4
          </span>
        }
      >
        Insiders in this issuer
      </SectionTitle>
      <Card>
        {issuer ? (
          <>
            <p className="text-[13px]">
              <span className="font-medium">{plural(issuer.insiders, "insider")}</span> of{" "}
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
            <div className="mt-3 space-y-2">
              {owners.map((p) => (
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
            </div>
            <Disclosure
              size="sm"
              className="mt-3"
              lead="Values are shares × the price as filed, not a disclosed range. Kept apart from the member figures above — nothing here enters them."
            >
              <p>Primary reporting owners from stored Form 4s.</p>
            </Disclosure>
            <a
              href={href}
              className="mt-2 inline-block text-[12px] text-muted-foreground underline-offset-2 hover:text-primary hover:underline"
            >
              every stored insider trade in {ticker} →
            </a>
          </>
        ) : (
          <Quiet>
            No stored Form 4 trade in {ticker} in the last {CROSS_WINDOW_DAYS} days.{" "}
            {allTime ? (
              <>
                {plural(allTime.trades, "trade")} stored all-time —{" "}
                <a href={href} className="underline-offset-2 hover:text-primary hover:underline">
                  see the issuer
                </a>
                .
              </>
            ) : (
              "No stored filing carries this symbol."
            )}
          </Quiet>
        )}
      </Card>
    </section>
  );
}
