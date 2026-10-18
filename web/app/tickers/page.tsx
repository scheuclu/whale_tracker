import { MoneyText } from "../money";
import { getSectorLeaderboard, getTickerMembers, getTickers, getTransactions, type SectorRow } from "@/lib/queries";
import {
  getInsiderIssuer,
  getIssuerInsiders,
  type IssuerInsiderRow,
  type IssuerRow,
} from "@/lib/insider-queries";
import { memberHref, memberLabel, range, shortDate, usd } from "@/lib/format";
import { AgentAlternates } from "../agent-alternates";
import {
  Card,
  DivergingSplit,
  Empty,
  MagnitudeBars,
  SectionTitle,
  StatTile,
  VOLUME_NOTE,
  VolumeRange,
} from "../charts";
import { ExportLink } from "../feed-controls";
import { ActionBadge, Amount, OptionBadge, OwnerTag, ResponsiveTable, RoleTag, SectorTag } from "../ui";
import { ASSET_TYPE_LABEL } from "@/lib/format";
import { getTimelineTrades, type TimelineTrade } from "@/lib/timeline-queries";
import { TradeTimeline } from "../timeline";
import { Disclosure, RangeCaption } from "../disclosure";
import { PAGE_STACK, PageHeader, PillLinks, Quiet } from "../page-header";
import { TradeList, TradeRow } from "../trade-row";
import { assetLabel } from "@/lib/asset-label";
import { TickerMembers } from "./ticker-members";
import {
  ROW_LIMITS,
  TICKER_SORT,
  isDefaultSort,
  parseLimit,
  parseSort,
  query,
  sortParams,
  type TickerSortKey,
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

export const dynamic = "force-dynamic";

const TICKER_ORDER_NAMES: Record<TickerSortKey, string> = {
  ticker: "ticker",
  asset: "asset name",
  members: "members trading",
  trades: "trades",
  buysell: "share of purchases",
  volume: "estimated volume",
  range: "disclosed floor",
};

const WINDOWS = [
  { days: 30, label: "30d" },
  { days: 90, label: "90d" },
  { days: 365, label: "1y" },
  { days: undefined, label: "All" },
];

export default async function TickersPage({
  searchParams,
}: {
  searchParams: Promise<{ t?: string; w?: string; sort?: string; dir?: string; n?: string }>;
}) {
  const params = await searchParams;
  const days = params.w === "all" ? undefined : Number(params.w) || 90;

  if (params.t) return <TickerDetail ticker={params.t.toUpperCase()} />;

  const sort = parseSort(TICKER_SORT, params);
  const { n, limit } = parseLimit(params.n);
  const isDefaultTable = !n && isDefaultSort(TICKER_SORT, sort);
  let rows, sectors, table;
  try {
    // The charts rank by their own measure; the table follows the URL's
    // sort, applied in SQL to every ticker in the window before the limit.
    [rows, sectors, table] = await Promise.all([
      getTickers(days, 40),
      getSectorLeaderboard(days),
      isDefaultTable ? null : getTickers(days, limit, sort),
    ]);
  } catch (err) {
    return <Empty>{(err as Error).message}</Empty>;
  }
  if (!rows.length) return <Empty>No transactions in this window.</Empty>;
  table ??= rows;

  const byPeople = [...rows].sort((a, b) => b.politicians - a.politicians || b.volume_mid - a.volume_mid);
  // The default order is volume, so the charts' first row is the window's largest.
  const maxVolume = rows[0]?.volume_mid ?? 0;
  const total = table[0]?.total_rows ?? table.length;
  const rowsParam = n === "more" ? "200" : n;
  const keep = { w: params.w, n: rowsParam };
  const keepSort = sortParams(TICKER_SORT, sort);
  const header = (column: TickerSortKey, label: string, opts: { align?: "left" | "right"; hint?: string } = {}) => (
    <SortHeader
      spec={TICKER_SORT}
      sort={sort}
      column={column}
      href={sortHref(TICKER_SORT, sort, column, { path: "/tickers", keep, hash: "all-tickers" })}
      align={opts.align}
      hint={opts.hint}
    >
      {label}
    </SortHeader>
  );
  const withRows = (count: string) => `/tickers${query({ w: params.w, ...keepSort, n: count })}#all-tickers`;

  return (
    <div className={PAGE_STACK}>
      <PageHeader
        title="Tickers"
        subtitle="What members of Congress trade, ranked over a window measured on trade date. Volumes are estimates from disclosed brackets."
        aside={
          <PillLinks
            label="Window"
            note="by trade date"
            items={WINDOWS.map((w) => {
              const key = w.days ? String(w.days) : "all";
              return {
                href: `/tickers${query({ w: key, ...keepSort })}`,
                label: w.label,
                active: (params.w ?? "90") === key,
              };
            })}
          />
        }
      />

      <section className="grid gap-6 lg:grid-cols-2">
        <div>
          <SectionTitle>Most traded by volume</SectionTitle>
          <Card>
            <MagnitudeBars
              data={rows.slice(0, 12).map((r) => ({
                key: r.ticker,
                label: r.ticker,
                sublabel: assetLabel(r.asset_name, { ticker: r.ticker }).slice(0, 28) || undefined,
                title: r.asset_name ?? undefined,
                value: r.volume_mid,
                valueLabel: usd(r.volume_mid),
                detail: `disclosed ${range(r.volume_min, r.volume_max)}`,
                href: `/tickers?t=${encodeURIComponent(r.ticker)}`,
              }))}
              note={VOLUME_NOTE}
            />
            <p className="mt-3 text-xs text-muted-foreground">
              Estimated from disclosure brackets — see each ticker for the disclosed range.
            </p>
          </Card>
        </div>

        <div>
          <SectionTitle>Most members trading</SectionTitle>
          <Card>
            <DivergingSplit
              unit="distinct members"
              data={byPeople.slice(0, 12).map((r) => ({
                key: r.ticker,
                label: r.ticker,
                sublabel: `${r.politicians} total`,
                buy: r.buy_politicians,
                sell: r.sell_politicians,
                href: `/tickers?t=${encodeURIComponent(r.ticker)}`,
              }))}
            />
          </Card>
        </div>
      </section>

      <section id="all-tickers" className="table-anchor">
        <SectionTitle>All tickers</SectionTitle>
        <ResponsiveTable>
          <table className={DATA_TABLE}>
            <StickyThead>
              <tr className={HEAD_ROW}>
                {header("ticker", "Ticker", { align: "left" })}
                {header("asset", "Asset", { align: "left" })}
                {header("members", "Members", { hint: "Distinct members who traded the ticker in the window." })}
                {header("trades", "Trades")}
                {header("buysell", "Buy / sell", {
                  hint: "Purchases / sales. Sorts by the share that are purchases; exchanges count as neither.",
                })}
                {header("volume", "Volume (est.)", {
                  hint: "Sum of disclosed bracket midpoints — an estimate, not a reported figure. An open-ended top bracket counts at its floor.",
                })}
                {header("range", "Disclosed range", {
                  hint: "The full range the disclosed brackets permit. Sorts by the floor; ≥ marks an open-ended top bracket, which has no ceiling.",
                })}
              </tr>
            </StickyThead>
            <RowLinkBody>
              {table.map((r) => (
                <tr key={r.ticker} className={BODY_ROW} data-href={`/tickers?t=${encodeURIComponent(r.ticker)}`}>
                  <td className="px-3 py-2">
                    <a
                      href={`/tickers?t=${encodeURIComponent(r.ticker)}`}
                      className="row-name font-mono font-semibold hover:text-primary"
                    >
                      {r.ticker}
                    </a>
                  </td>
                  <td className="max-w-[10rem] truncate px-3 py-2 text-muted-foreground sm:max-w-[18rem]" title={r.asset_name ?? undefined}>
                    {assetLabel(r.asset_name, { ticker: r.ticker }) || r.asset_name}
                  </td>
                  <td className="tabular px-3 py-2 text-right font-medium">{r.politicians}</td>
                  <td className="tabular px-3 py-2 text-right text-muted-foreground">{r.trades}</td>
                  <SplitCell buys={r.buys} sells={r.sells} />
                  <BarCell value={r.volume_mid} max={maxVolume}>
                    {usd(r.volume_mid)}
                  </BarCell>
                  <td className="tabular px-3 py-2 text-right text-muted-foreground">
                    <MoneyText value={r.volume_max == null ? `≥${usd(r.volume_min)}` : `${usd(r.volume_min)}–${usd(r.volume_max)}`} />
                  </td>
                </tr>
              ))}
            </RowLinkBody>
          </table>
        </ResponsiveTable>
        <TableFooter
          shown={table.length}
          total={total}
          noun="tickers in this window"
          orderLabel={describeSort(TICKER_SORT, sort, TICKER_ORDER_NAMES)}
          moreHref={table.length < ROW_LIMITS.more ? withRows("200") : undefined}
          allHref={withRows("all")}
        />
      </section>

      <SectorLeaderboard sectors={sectors} />
    </div>
  );
}

/**
 * Members and trades per industry group inside the window (#55), over the
 * same ticker-bearing rows as the tables above. Two measures, two charts:
 * breadth (distinct members) and estimated volume share one hue each, and
 * the unclassified remainder closes each list so the groups never claim
 * more than they cover.
 */
function SectorLeaderboard({ sectors }: { sectors: SectorRow[] }) {
  const classified = sectors.filter((s) => s.industry_group);
  const unclassified = sectors.find((s) => !s.industry_group);
  const tail = unclassified ? [unclassified] : [];
  const byVolume = [...classified].sort((a, b) => b.volume_mid - a.volume_mid);
  const tickersTotal = sectors.reduce((n, s) => n + s.tickers, 0);
  const tickersKnown = classified.reduce((n, s) => n + s.tickers, 0);
  return (
    <section>
      <SectionTitle right={<span className="text-[11px] text-muted-foreground">same window as above</span>}>
        By sector
      </SectionTitle>
      {classified.length ? (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <h3 className="mb-3 text-[11px] font-medium uppercase tracking-[0.07em] text-muted-foreground">
              Most members trading
            </h3>
            <MagnitudeBars
              variant="name"
              data={[...classified, ...tail].map((s) => ({
                key: s.industry_group ?? "unclassified",
                label: s.industry_group ?? "Unclassified",
                sublabel: `${s.trades} trade${s.trades === 1 ? "" : "s"} · ${s.tickers} ticker${s.tickers === 1 ? "" : "s"}`,
                value: s.politicians,
                valueLabel: `${s.politicians}`,
              }))}
            />
          </Card>
          <Card>
            <h3 className="mb-3 text-[11px] font-medium uppercase tracking-[0.07em] text-muted-foreground">
              Estimated volume
            </h3>
            <MagnitudeBars
              variant="name"
              data={[...byVolume, ...tail].map((s) => ({
                key: s.industry_group ?? "unclassified",
                label: s.industry_group ?? "Unclassified",
                sublabel: `disclosed ${range(s.volume_min, s.volume_max)}`,
                value: s.volume_mid,
                valueLabel: usd(s.volume_mid),
                detail: `disclosed ${range(s.volume_min, s.volume_max)}`,
              }))}
              note={VOLUME_NOTE}
            />
            <p className="mt-3 text-xs text-muted-foreground">
              Bracket midpoints; the disclosed range is under each bar.
            </p>
          </Card>
        </div>
      ) : (
        <Quiet>
          No sector is known for any ticker yet. The pipeline classifies issuers from their
          EDGAR SIC codes after each run.
        </Quiet>
      )}
      <Disclosure
        size="sm"
        className="mt-3"
        lead={`Industry groups fold each issuer’s EDGAR SIC code into twelve sectors; ${tickersKnown} of ${tickersTotal} tickers in this window are classified.`}
      >
        <p>
          The rest are ETF trusts and other issuers EDGAR lists no SIC for, symbols not in EDGAR&rsquo;s
          company list, or issuers the fill has not reached yet.
        </p>
      </Disclosure>
    </section>
  );
}

async function TickerDetail({ ticker }: { ticker: string }) {
  const [all, trades, optionTrades, timeline, members] = await Promise.all([
    getTickers(undefined, 5000),
    getTransactions({ ticker, limit: 200 }),
    getTransactions({ ticker, options: true, limit: 500 }),
    getTimelineTrades({ ticker }),
    getTickerMembers(ticker, undefined, 1000),
  ]);
  const stat = all.find((r) => r.ticker === ticker);
  if (!stat) return <Empty>No disclosed trades for {ticker}.</Empty>;

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
                <tr className="border-b border-border text-left text-[12px] font-medium text-muted-foreground">
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
                  <tr key={r.id} className="border-b border-border/60 transition-colors duration-(--dur-fast) last:border-0 hover:bg-raised">
                    <td className="px-4 py-2">
                      <OptionBadge kind={r.option_kind} strikeCents={r.strike_cents} expiry={null} />
                    </td>
                    <td className="px-4 py-2">
                      <ActionBadge action={r.action} />
                    </td>
                    <td className="px-4 py-2">
                      <a href={memberHref(r.member_name)} className="font-medium hover:text-primary">
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
        <Empty>Insider data unavailable: {(err as Error).message}</Empty>
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
