import { redirect } from "next/navigation";
import { getConsensusTickers, getPipeline, getTransactions } from "@/lib/queries";
import { getBothSides, getSharedTickers, type BothSidesRow, type SharedTickers } from "@/lib/crossover-queries";
import { memberHref, memberLabel, shortDate, usd } from "@/lib/format";
import { Card, DivergingSplit, Empty, SectionTitle, StatTile } from "./charts";
import {
  ActionBadge,
  Amount,
  DelayTag,
  OptionBadge,
  OwnerTag,
  PartyBadge,
  ResponsiveTable,
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
