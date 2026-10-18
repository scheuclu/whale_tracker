import { redirect } from "next/navigation";
import { getConsensusTickers, getPipeline, getTransactions } from "@/lib/queries";
import { memberHref, memberLabel, shortDate, usd } from "@/lib/format";
import { Card, DivergingSplit, Empty, SectionTitle, StatTile } from "./charts";
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

export default async function FeedPage({
  searchParams,
}: {
  searchParams: Promise<{ action?: string; member?: string }>;
}) {
  const params = await searchParams;
  // The feed used to double as the member view; the member page replaced it.
  if (params.member) redirect(memberHref(params.member, params.action));

  let rows, consensus, pipeline;
  try {
    [rows, consensus, pipeline] = await Promise.all([
      getTransactions({ action: params.action, limit: 120 }),
      getConsensusTickers(90, 6),
      getPipeline(),
    ]);
  } catch (err) {
    return <Empty>{(err as Error).message}</Empty>;
  }

  // Transcribed rows are listed but never summed: the amount is a box read
  // off a scan. Mirrors `MID` in lib/queries.ts.
  const totalMid = rows.reduce(
    (a, r) =>
      r.transcribed
        ? a
        : a + (r.amount_exact_cents ?? ((r.amount_min_cents ?? 0) + (r.amount_max_cents ?? r.amount_min_cents ?? 0)) / 2),
    0
  );
  const transcribedShown = rows.filter((r) => r.transcribed).length;

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

      <section>
        <SectionTitle
          right={
            <div className="flex gap-1 text-[11px]">
              {[
                { k: undefined, label: "All" },
                { k: "buy", label: "Buys" },
                { k: "sell", label: "Sells" },
              ].map((f) => (
                <a
                  key={f.label}
                  href={f.k ? `/?action=${f.k}` : "/"}
                  className={`rounded-full border px-2.5 py-1 transition-colors ${
                    (params.action ?? undefined) === f.k
                      ? "border-primary/40 bg-primary/10 text-foreground"
                      : "border-border text-muted-foreground hover:bg-muted"
                  }`}
                >
                  {f.label}
                </a>
              ))}
            </div>
          }
        >
          Recent trades
        </SectionTitle>

        {rows.length ? (
          <>
            <p className="mb-3 text-xs text-muted-foreground">
              {rows.length} trades shown · {usd(totalMid)} estimated total (bracket midpoints)
              {transcribedShown
                ? ` · ${transcribedShown} transcribed from scans, not in the total`
                : ""}
            </p>
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
          </>
        ) : (
          <Empty>No trades match this filter.</Empty>
        )}
      </section>
    </div>
  );
}
