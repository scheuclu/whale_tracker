import { redirect } from "next/navigation";
import { getConsensusTickers, getPipeline, getTransactionTotals, getTransactions } from "@/lib/queries";
import { FILTER_KEYS, feedHref, parseOffset, parseTransactionFilters } from "@/lib/feed-filters";
import { memberHref, memberLabel, shortDate } from "@/lib/format";
import { Card, DivergingSplit, Empty, SectionTitle, StatTile } from "./charts";
import { ExportLink, FilterBar, Pagination, ShownLine } from "./feed-controls";
import {
  ActionBadge,
  Amount,
  DelayTag,
  OptionBadge,
  OwnerTag,
  PartyBadge,
  ScanTag,
  TickerChip,
} from "./ui";

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
          right={
            <div className="flex items-center gap-1 text-[11px]">
              {[
                { k: undefined, label: "All" },
                { k: "buy" as const, label: "Buys" },
                { k: "sell" as const, label: "Sells" },
              ].map((f) => (
                <a
                  key={f.label}
                  href={feedHref({ ...filters, action: f.k })}
                  className={`rounded-full border px-2.5 py-1 transition-colors ${
                    filters.action === f.k
                      ? "border-primary/40 bg-primary/10 text-foreground"
                      : "border-border text-muted-foreground hover:bg-muted"
                  }`}
                >
                  {f.label}
                </a>
              ))}
              <span className="mx-1 h-4 w-px bg-border" aria-hidden />
              <ExportLink filters={filters} />
            </div>
          }
        >
          Recent trades
        </SectionTitle>

        <FilterBar filters={filters} ignored={ignored} />

        {rows.length ? (
          <>
            <ShownLine offset={offset} shown={rows.length} totals={totals} />
            <div className="space-y-1.5">
              {rows.map((r) => (
                <Card key={r.id} className="lift px-4 py-3">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                    <ActionBadge action={r.action} />
                    <TickerChip ticker={r.ticker} type={r.asset_type} />
                    <OptionBadge kind={r.option_kind} strikeCents={r.strike_cents} expiry={r.expiry} />
                    <Amount
                      min={r.amount_min_cents}
                      max={r.amount_max_cents}
                      exact={r.amount_exact_cents}
                    />
                    <div className="flex-1" />
                    <span className="tabular text-xs text-muted-foreground">
                      {shortDate(r.tx_date)}
                    </span>
                    <DelayTag days={r.delay_days} inconsistent={r.dates_inconsistent} />
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
                    <PartyBadge party={r.party} />
                    <a href={memberHref(r.member_name)} className="font-medium hover:text-primary">
                      {memberLabel(r.member_name, null, r.state, r.district, r.chamber)}
                    </a>
                    <OwnerTag owner={r.owner} />
                    <ScanTag transcribed={r.transcribed} docId={r.doc_id} />
                    <span className="truncate text-muted-foreground">· {r.asset_name}</span>
                    <a
                      href={r.pdf_url}
                      target="_blank"
                      rel="noreferrer"
                      className="ml-auto text-[11px] text-muted-foreground underline-offset-2 hover:text-primary hover:underline"
                    >
                      filing
                    </a>
                  </div>
                </Card>
              ))}
            </div>
            <Pagination filters={filters} offset={offset} shown={rows.length} total={totals.trades} page={PAGE} />
          </>
        ) : offset > 0 && totals.trades ? (
          <Empty>
            Nothing past trade {totals.trades.toLocaleString()}.{" "}
            <a href={feedHref(filters)} className="underline underline-offset-2 hover:text-primary">
              Back to the newest
            </a>
          </Empty>
        ) : (
          <Empty>No trades match this filter.</Empty>
        )}
      </section>
    </div>
  );
}
