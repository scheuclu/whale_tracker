import { getInsiderMonthly } from "@/lib/insider-queries";
import { getMonthlyDelay, getMonthlyScans, getMonthlyTrades, getRisingTickers } from "@/lib/trend-queries";
import { MONTH_KEY, axisLabel, monthKeys, monthLabel, previousMonth } from "@/lib/months";
import { tickerHref, usd } from "@/lib/format";
import {
  Card,
  ChartLegend,
  Empty,
  MagnitudeBars,
  MonthlyColumns,
  MonthlyLines,
  SectionTitle,
  StatTile,
  textureStyle,
  type ColumnDatum,
  type Texture,
} from "../charts";
import { DataTable } from "../data-table";
import { pageMetadata } from "@/lib/seo";

export const dynamic = "force-dynamic";

/** Window and ticker parameters are views of `/trends`. */
export const metadata = pageMetadata({
  title: "Congressional trading trends by month",
  description:
    "Monthly trades disclosed by members of Congress, disclosure delay against the 45-day STOCK Act deadline, rising tickers and scanned paper filings, beside SEC Form 4 insider activity.",
  path: "/trends",
});

/**
 * Change over time. Every other page ranks a snapshot; this one buckets by
 * calendar month. The congressional series are on TRADE date, so the newest
 * month or two are incomplete by construction — a member has 45 days to
 * file — and the footnote carries the measured lag rather than hiding the
 * short bars. Insider series are on trade date too but fill within days;
 * scans are on filing date, the only date a scan has.
 */

const WINDOWS = [
  { months: 6, label: "6m" },
  { months: 12, label: "12m" },
  { months: 24, label: "24m" },
];

/** Party inside a direction is carried by texture; the hue is the direction's. */
const PARTIES: { key: "d" | "r" | "other"; label: string; texture: Texture }[] = [
  { key: "d", label: "Democrat", texture: "solid" },
  { key: "r", label: "Republican", texture: "hatch" },
  { key: "other", label: "Other or unmatched", texture: "hatch-mirror" },
];

const BUY = "var(--viz-buy)";
const SELL = "var(--viz-sell)";
const SEQ = "var(--viz-seq)";
const GREY = "var(--viz-axis)";

const num = (n: number) => n.toLocaleString();
const days = (d: number | null) => (d == null ? "—" : `${Number.isInteger(d) ? d : d.toFixed(1)}d`);

function pill(active: boolean) {
  return `rounded-full border px-2.5 py-1 transition-colors ${
    active
      ? "border-primary/40 bg-primary/10 text-foreground"
      : "border-border text-muted-foreground hover:bg-muted"
  }`;
}

export default async function TrendsPage({
  searchParams,
}: {
  searchParams: Promise<{ w?: string; t?: string }>;
}) {
  const params = await searchParams;
  const months = WINDOWS.find((w) => String(w.months) === params.w)?.months ?? 12;
  const keys = monthKeys(months);
  const current = keys[keys.length - 1];
  // The rising-ticker comparison defaults to the last complete calendar
  // month: the current one is days old and most of its trades are still
  // unfiled, so "this month vs the previous" would compare noise to signal.
  const lastComplete = previousMonth(current);
  const pick =
    params.t && MONTH_KEY.test(params.t) && keys.includes(params.t) ? params.t : lastComplete;
  const query = (overrides: { w?: number; t?: string }) => {
    const q = new URLSearchParams();
    const w = "w" in overrides ? overrides.w : months;
    const t = "t" in overrides ? overrides.t : params.t;
    if (w && w !== 12) q.set("w", String(w));
    if (t) q.set("t", t);
    const s = q.toString();
    return s ? `/trends?${s}` : "/trends";
  };

  let trades, delay, rising, insiders, scans;
  try {
    [trades, delay, rising, insiders, scans] = await Promise.all([
      getMonthlyTrades(months),
      getMonthlyDelay(months),
      getRisingTickers(pick, 10),
      // A database from before the insider source has no such tables.
      getInsiderMonthly(months).catch(() => null),
      getMonthlyScans(months),
    ]);
  } catch (err) {
    return <Empty>{(err as Error).message}</Empty>;
  }

  const labels = keys.map((k, i) => axisLabel(k, i === 0));
  const names = keys.map((k) => monthLabel(k));
  const at = <T extends { month: string }>(rows: T[] | null, month: string) =>
    rows?.find((r) => r.month === month);
  const t1 = at(trades, lastComplete);
  const t0 = at(trades, previousMonth(lastComplete));
  const d1 = at(delay.months, lastComplete);
  const i1 = at(insiders, lastComplete);
  const top = rising[0];

  const tradeColumns: ColumnDatum[] = trades.map((r, i) => ({
    key: r.month,
    label: labels[i],
    name: names[i],
    up: PARTIES.map((p) => ({
      key: `buy_${p.key}`,
      label: `Bought · ${p.label}`,
      value: r[`buy_${p.key}` as const],
      fill: BUY,
      texture: p.texture,
    })),
    down: PARTIES.map((p) => ({
      key: `sell_${p.key}`,
      label: `Sold · ${p.label}`,
      value: r[`sell_${p.key}` as const],
      fill: SELL,
      texture: p.texture,
    })),
    upLabel: r.buys ? num(r.buys) : "",
    downLabel: r.sells ? num(r.sells) : "",
    tip: [
      `${num(r.buys)} bought — D ${num(r.buy_d)}, R ${num(r.buy_r)}${r.buy_other ? `, other ${num(r.buy_other)}` : ""}`,
      `${num(r.sells)} sold — D ${num(r.sell_d)}, R ${num(r.sell_r)}${r.sell_other ? `, other ${num(r.sell_other)}` : ""}`,
      `${num(r.trades)} trades in all${r.transcribed ? ` · ${num(r.transcribed)} transcribed from scans` : ""}`,
    ],
  }));

  const insiderColumns: ColumnDatum[] = (insiders ?? []).map((r, i) => ({
    key: r.month,
    label: labels[i],
    name: names[i],
    up: [{ key: "buy", label: "Bought", value: r.buy_value, fill: BUY }],
    down: [{ key: "sell", label: "Sold", value: r.sell_value, fill: SELL }],
    upLabel: r.buy_value ? usd(r.buy_value) : "",
    downLabel: r.sell_value ? usd(r.sell_value) : "",
    tip: [
      `${usd(r.buy_value)} bought · ${num(r.buys)} trade${r.buys === 1 ? "" : "s"}`,
      `${usd(r.sell_value)} sold · ${num(r.sells)} trade${r.sells === 1 ? "" : "s"}`,
      `${num(r.filings)} filing${r.filings === 1 ? "" : "s"}` +
        (r.unpriced ? ` · ${num(r.unpriced)} unpriced` : "") +
        (r.implausible ? ` · ${num(r.implausible)} implausible, in no value` : ""),
    ],
  }));

  const scanColumns: ColumnDatum[] = scans.map((r, i) => ({
    key: r.month,
    label: labels[i],
    name: names[i],
    up: [
      { key: "transcribed", label: "Transcribed", value: r.transcribed, fill: SEQ },
      { key: "not", label: "Not transcribed", value: r.unread + r.refused, fill: GREY },
    ],
    upLabel: r.scans ? num(r.scans) : "",
    tip: [
      `${num(r.transcribed)} transcribed · ${num(r.rows_transcribed)} row${r.rows_transcribed === 1 ? "" : "s"} read`,
      `${num(r.unread)} unread · ${num(r.refused)} refused`,
      `${num(r.scans)} paper filing${r.scans === 1 ? "" : "s"} in all`,
    ],
  }));

  const risingMonths = keys.slice(-6);

  return (
    <div className="space-y-8">
      {/* Named by the active tab visually; the heading is for screen readers and crawlers. */}
      <h1 className="sr-only">Congressional trading trends by month</h1>
      <div className="flex flex-wrap items-center gap-1 text-[11px]">
        {WINDOWS.map((w) => (
          <a key={w.months} href={query({ w: w.months })} className={pill(months === w.months)}>
            {w.label}
          </a>
        ))}
        <span className="ml-2 text-muted-foreground">
          calendar months, measured on trade date · the newest one or two are still filling in
        </span>
      </div>

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label={`Trades · ${monthLabel(lastComplete, "short")}`}
          value={t1 ? num(t1.trades) : "—"}
          hint={
            t1
              ? `${num(t1.buys)} bought · ${num(t1.sells)} sold` +
                (t0 ? ` · ${monthLabel(t0.month, "short").split(" ")[0]} ${num(t0.trades)}` : "")
              : undefined
          }
        />
        <StatTile
          label={`Median delay · ${monthLabel(lastComplete, "short")}`}
          value={d1 ? days(d1.median) : "—"}
          hint={d1 && d1.n ? `p90 ${days(d1.p90)} · ${num(d1.late)} past 45 days` : "no measurable trades"}
        />
        <StatTile
          label={`Rising ticker · ${monthLabel(pick, "short")}`}
          value={top?.ticker ?? "—"}
          hint={
            top
              ? `+${top.gain} member${top.gain === 1 ? "" : "s"} vs ${monthLabel(previousMonth(pick), "short")}`
              : "no ticker gained members"
          }
        />
        <StatTile
          label={`Insider sold · ${monthLabel(lastComplete, "short")}`}
          value={i1 ? usd(i1.sell_value) : "—"}
          hint={i1 ? `${usd(i1.buy_value)} bought · shares × reported price` : "no insider tables"}
        />
      </section>

      <section>
        <SectionTitle right={<span className="text-[11px] text-muted-foreground">rows disclosed, by trade month</span>}>
          Trades by direction and party
        </SectionTitle>
        <Card>
          <ChartLegend
            items={[
              { label: "Bought", style: textureStyle(BUY) },
              { label: "Sold", style: textureStyle(SELL) },
              ...PARTIES.map((p) => ({ label: p.label, style: textureStyle(GREY, p.texture) })),
            ]}
            note="trades"
          />
          <div className="mt-4">
            <MonthlyColumns data={tradeColumns} />
          </div>
          <p className="mt-3 text-[11px] text-muted-foreground">
            Bought columns rise from the baseline, sold columns fall from it; the fill pattern inside
            each marks the party (solid Democrat, hatched Republican). Exchanges are in the month&rsquo;s
            total but in neither direction. This counts disclosed rows, not dollars: members disclose
            a bracket, and a column of bracket midpoints would be a column of estimates.
          </p>
          <DataTable
            caption="Trades per month by direction and party"
            columns={["Month", "Trades", "Bought", "D", "R", "Other", "Sold", "D", "R", "Other", "From scans"]}
            rows={trades.map((r) => [
              monthLabel(r.month, "short"),
              r.trades,
              r.buys,
              r.buy_d,
              r.buy_r,
              r.buy_other,
              r.sells,
              r.sell_d,
              r.sell_r,
              r.sell_other,
              r.transcribed,
            ])}
          />
        </Card>
      </section>

      <section>
        <SectionTitle right={<span className="text-[11px] text-muted-foreground">days from trade to filing, by trade month</span>}>
          Disclosure delay
        </SectionTitle>
        <Card>
          <ChartLegend
            items={[
              { label: "Median", style: { background: SEQ }, kind: "line" },
              { label: "90th percentile", style: { background: GREY }, kind: "line" },
              { label: "45-day deadline", style: { background: GREY, height: 1 }, kind: "line" },
            ]}
            note="days"
          />
          <div className="mt-4">
            <MonthlyLines
              labels={labels}
              names={names}
              series={[
                { key: "median", label: "median", stroke: SEQ, values: delay.months.map((m) => m.median) },
                { key: "p90", label: "p90", stroke: GREY, values: delay.months.map((m) => m.p90) },
              ]}
              reference={{ value: 45, label: "45-day deadline" }}
              height={180}
              tips={delay.months.map((m) =>
                m.n
                  ? [
                      `median ${days(m.median)} · p90 ${days(m.p90)}`,
                      `${num(m.n)} trades · ${num(m.late)} past 45 days`,
                    ]
                  : ["no trades disclosed yet"]
              )}
            />
          </div>
          <p className="mt-3 text-[11px] text-muted-foreground">
            Trade date to the report reaching the Clerk — never the report&rsquo;s own
            &ldquo;notification date&rdquo;, which reads zero for a member trading their own account.
            A month&rsquo;s delay can only grow as its late filings arrive, so the right-hand end of
            both lines is a floor. A trade whose dates contradict each other is left out rather than
            counted as a negative delay.
          </p>
          <DataTable
            caption="Disclosure delay per month"
            columns={["Month", "Trades", "Median", "p90", "Past 45 days"]}
            rows={delay.months.map((m) => [
              monthLabel(m.month, "short"),
              m.n,
              days(m.median),
              days(m.p90),
              m.late,
            ])}
          />
        </Card>
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        <div>
          <SectionTitle
            right={
              <div className="flex gap-1 text-[11px]">
                {risingMonths.map((k) => (
                  <a key={k} href={query({ t: k })} className={pill(k === pick)}>
                    {axisLabel(k, k === risingMonths[0])}
                  </a>
                ))}
              </div>
            }
          >
            Rising tickers
          </SectionTitle>
          <Card>
            <p className="mb-3 text-[11px] text-muted-foreground">
              Members trading each ticker in {monthLabel(pick)} against {monthLabel(previousMonth(pick))},
              equity-like assets only. The bar is the gain.
            </p>
            {rising.length ? (
              <MagnitudeBars
                data={rising.map((r) => ({
                  key: r.ticker,
                  label: r.ticker,
                  // Direction in words beside the ticker; the asset name is in the table.
                  sublabel: `${r.buy_members} bought, ${r.sell_members} sold`,
                  value: r.gain,
                  valueLabel: `+${r.gain} (${r.prev_members}→${r.members})`,
                  href: tickerHref(r.ticker),
                }))}
              />
            ) : (
              <Empty>No ticker gained members in {monthLabel(pick)} over {monthLabel(previousMonth(pick))}.</Empty>
            )}
            <DataTable
              caption={`Tickers that gained members in ${monthLabel(pick)}`}
              columns={["Ticker", "Asset", "Members", "Previous", "Gain", "Bought", "Sold", "Trades"]}
              rows={rising.map((r) => [
                r.ticker,
                r.asset_name?.slice(0, 28) ?? "—",
                r.members,
                r.prev_members,
                `+${r.gain}`,
                r.buy_members,
                r.sell_members,
                r.trades,
              ])}
            />
          </Card>
        </div>

        <div>
          <SectionTitle right={<span className="text-[11px] text-muted-foreground">shares × reported price, by trade month</span>}>
            Insider buying and selling
          </SectionTitle>
          <Card>
            {insiders ? (
              <>
                <ChartLegend
                  items={[
                    { label: "Bought", style: textureStyle(BUY) },
                    { label: "Sold", style: textureStyle(SELL) },
                  ]}
                  note="value"
                />
                <div className="mt-4">
                  <MonthlyColumns data={insiderColumns} />
                </div>
                <p className="mt-3 text-[11px] text-muted-foreground">
                  Form 4 values are exact but computed — shares × the price as filed, which may be a
                  weighted average. Only filings with open-market trades of $50k or more in one direction
                  are stored, and the series starts where the daily-index history does. A row whose
                  as-filed value is implausible is counted as a trade and in no value.
                </p>
                <DataTable
                  caption="Insider buy and sell value per month"
                  columns={["Month", "Filings", "Bought", "Buys", "Sold", "Sells", "Unpriced"]}
                  rows={insiders.map((r) => [
                    monthLabel(r.month, "short"),
                    r.filings,
                    usd(r.buy_value),
                    r.buys,
                    usd(r.sell_value),
                    r.sells,
                    r.unpriced,
                  ])}
                />
              </>
            ) : (
              <Empty>No insider tables in this database yet.</Empty>
            )}
          </Card>
        </div>
      </section>

      <section>
        <SectionTitle right={<span className="text-[11px] text-muted-foreground">paper filings, by filing month</span>}>
          Scans transcribed
        </SectionTitle>
        <Card>
          <ChartLegend
            items={[
              { label: "Transcribed", style: textureStyle(SEQ) },
              { label: "Not transcribed", style: textureStyle(GREY) },
            ]}
            note="filings"
          />
          <div className="mt-4">
            <MonthlyColumns data={scanColumns} height={96} />
          </div>
          <p className="mt-3 text-[11px] text-muted-foreground">
            A paper filing — a House scan or a Senate paper report — has no text layer and no trade
            dates until a vision model transcribes it, so this series is on filing date. Transcribed
            rows count as trades on this site and enter no total. Transcription is off by default
            (<code className="font-mono">vision.enabled</code>); not transcribed means unread or refused
            by the grid reader. Inspect any scan on the{" "}
            <a href="/scans" className="underline underline-offset-2 hover:text-primary">
              Scans
            </a>{" "}
            page.
          </p>
          <DataTable
            caption="Paper filings per month"
            columns={["Month", "Filings", "Transcribed", "Rows read", "Refused", "Unread"]}
            rows={scans.map((r) => [
              monthLabel(r.month, "short"),
              r.scans,
              r.transcribed,
              r.rows_transcribed,
              r.refused,
              r.unread,
            ])}
          />
        </Card>
      </section>

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        Every congressional series above is bucketed on the <strong>trade date</strong>, never the
        filing date, so the newest month or two are incomplete by construction: members have 45 days
        to file.{" "}
        {delay.overall.median != null && delay.overall.p90 != null
          ? `Across this window the median trade reached the Clerk ${days(delay.overall.median)} after it was made and nine in ten within ${days(delay.overall.p90)}, so a month keeps filling for about two months after it ends. `
          : ""}
        A drop at the right-hand edge is usually filings that have not arrived yet, not a change in
        behaviour. Trades disclosed with a trade date outside the window — some 2026 filings report
        trades from years earlier — are not shown. Insider series are on trade date too but complete
        within days, as Form 4 is due two business days after the trade. Scans are on filing date, the
        only date a scan carries until it is transcribed.
      </p>
    </div>
  );
}
