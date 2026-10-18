import { redirect } from "next/navigation";
import { getConsensusTickers, getPipeline, getTransactionTotals, getTransactions } from "@/lib/queries";
import { getBothSides, getSharedTickers, type BothSidesRow, type SharedTickers } from "@/lib/crossover-queries";
import { FILTER_KEYS, feedHref, parseOffset, parseTransactionFilters } from "@/lib/feed-filters";
import { memberHref } from "@/lib/format";
import { Card, DivergingSplit, Empty, SectionTitle, StatTile } from "./charts";
import { ExportLink, FilterBar, Pagination, ShownLine } from "./feed-controls";
import { DirectionFilter, FeedList } from "./feed-list";
import { ActionBadge, ResponsiveTable } from "./ui";

export const dynamic = "force-dynamic";

/** Trades per page; `?offset=` pages through the rest, newest first. */
const PAGE = 120;

export default async function FeedPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const memberParam = Array.isArray(params.member) ? params.member[0] : params.member;
  const actionParam = Array.isArray(params.action) ? params.action[0] : params.action;
  // The feed used to double as the member view; the member page replaced it.
  if (memberParam) redirect(memberHref(memberParam, actionParam));

  const { filters, ignored } = parseTransactionFilters(params);
  const offset = parseOffset(params.offset);
  // The filter form submits every field, blank ones included; send the
  // reader to the canonical URL so a copied link carries only the filters.
  // Not when something was ignored: the notice about it must still render.
  if (!ignored.length && FILTER_KEYS.some((k) => params[k] === "")) redirect(feedHref(filters, offset));

  let rows, totals, consensus, pipeline;
  try {
    [rows, totals, consensus, pipeline] = await Promise.all([
      getTransactions({ ...filters, limit: PAGE, offset }),
      getTransactionTotals(filters),
      getConsensusTickers(90, 6),
      getPipeline(),
    ]);
  } catch (err) {
    return <Empty>{(err as Error).message}</Empty>;
  }

  return (
    <div className="space-y-8">
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Trades" value={pipeline.totals.transactions.toLocaleString()} hint="disclosed" />
        <StatTile label="Tickers" value={pipeline.totals.tickers.toLocaleString()} />
        <StatTile label="Members" value={pipeline.totals.members.toLocaleString()} hint="filing trades" />
        <StatTile label="Filings" value={pipeline.coverage.parsed.toLocaleString()} hint="parsed" />
      </section>

      {consensus.length ? (
        <section>
          <SectionTitle right={<span className="text-[11px] text-muted-foreground">last 90 days</span>}>
            Where members agree
          </SectionTitle>
          <Card>
            <DivergingSplit
              unit="members trading, by direction"
              data={consensus.map((c) => ({
                key: c.ticker,
                label: c.ticker,
                sublabel: c.asset_name?.slice(0, 26) ?? undefined,
                buy: c.buy_politicians,
                sell: c.sell_politicians,
                href: `/tickers?t=${encodeURIComponent(c.ticker)}`,
              }))}
            />
          </Card>
        </section>
      ) : null}

      <section id="trades">
        <SectionTitle
          right={<span className="text-[11px] text-muted-foreground">by trade date, newest first</span>}
        >
          Recent trades
        </SectionTitle>

        <FilterBar filters={filters} ignored={ignored} />

        <FeedList
          rows={rows}
          toolbar={
            <>
              <DirectionFilter current={filters.action} hrefFor={(k) => feedHref({ ...filters, action: k })} />
              <ExportLink
                filters={filters}
                className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              />
            </>
          }
          summary={<ShownLine offset={offset} shown={rows.length} totals={totals} />}
          empty={
            offset > 0 && totals.trades ? (
              <>
                Nothing past trade {totals.trades.toLocaleString()}.{" "}
                <a href={feedHref(filters)} className="underline underline-offset-2 hover:text-primary">
                  Back to the newest
                </a>
              </>
            ) : undefined
          }
        />
        <Pagination filters={filters} offset={offset} shown={rows.length} total={totals.trades} page={PAGE} />
      </section>

      <BothSides />
    </div>
  );
}

/** Trade-date window for the overlap. 30 days, not 90: this card wants both
 *  sides moving at once, and Form 4's two-business-day deadline fills the
 *  insider side immediately. */
const BOTH_SIDES_DAYS = 30;

/**
 * Tickers a member of Congress and a corporate insider traded the same way
 * inside the window. Two sets of books set beside each other — members from
 * House and Senate disclosures, insiders from SEC Form 4s — and never summed:
 * each count is that side's own aggregate, matched on the listed symbol alone.
 * Fetches its own data so a fault in either set of tables stays in this card.
 */
async function BothSides() {
  let rows: BothSidesRow[], shared: SharedTickers;
  try {
    [rows, shared] = await Promise.all([getBothSides(BOTH_SIDES_DAYS, 12), getSharedTickers(BOTH_SIDES_DAYS)]);
  } catch (err) {
    return (
      <section>
        <SectionTitle>Both sides</SectionTitle>
        <Empty>{(err as Error).message}</Empty>
      </section>
    );
  }
  if (!rows.length) return null;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

  return (
    <section>
      <SectionTitle
        right={
          <span className="text-[11px] text-muted-foreground">
            last {BOTH_SIDES_DAYS} days · {plural(shared.tickers, "ticker")} traded by both,{" "}
            {shared.same_direction} the same way
          </span>
        }
      >
        Both sides
      </SectionTitle>
      <ResponsiveTable>
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-border text-left text-[11px] uppercase tracking-[0.06em] text-muted-foreground">
              <th className="px-4 py-2.5 font-medium">Ticker</th>
              <th className="px-4 py-2.5 font-medium">Direction</th>
              <th className="px-4 py-2.5 text-right font-medium">Members</th>
              <th className="px-4 py-2.5 text-right font-medium">Insiders</th>
              <th className="px-4 py-2.5 font-medium">Issuer</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.ticker}-${r.direction}`} className="border-b border-border/50 last:border-0 hover:bg-muted/50">
                <td className="px-4 py-2">
                  <a
                    href={`/tickers?t=${encodeURIComponent(r.ticker)}`}
                    className="font-mono font-semibold hover:text-primary"
                  >
                    {r.ticker}
                  </a>
                </td>
                <td className="px-4 py-2">
                  <ActionBadge action={r.direction === "buy" ? "purchase" : "sale"} />
                </td>
                <td className="tabular px-4 py-2 text-right">
                  <a href={`/tickers?t=${encodeURIComponent(r.ticker)}`} className="font-medium hover:text-primary">
                    {plural(r.members, "member")}
                  </a>
                  <span className="text-muted-foreground"> · {plural(r.member_trades, "trade")}</span>
                </td>
                <td className="tabular px-4 py-2 text-right">
                  <a href={`/insiders?t=${encodeURIComponent(r.ticker)}`} className="font-medium hover:text-primary">
                    {plural(r.insiders, "insider")}
                  </a>
                  <span className="text-muted-foreground"> · {plural(r.insider_filings, "filing")}</span>
                </td>
                <td className="max-w-[18rem] truncate px-4 py-2 text-muted-foreground">
                  {r.issuer_name ?? r.asset_name}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ResponsiveTable>
      <p className="mt-3 text-[11px] text-muted-foreground">
        Two sets of books, never summed: members are distinct filers on House and Senate
        disclosures, insiders are distinct primary reporting owners on SEC Form 4s, matched on
        the listed symbol alone. Same direction, both inside the last {BOTH_SIDES_DAYS} days on
        trade date. Form 4 is due in two business days and a member&apos;s report in 45, so the
        member side of the most recent weeks is still arriving.
      </p>
    </section>
  );
}
