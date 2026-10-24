import { shortDate, tickerHref } from "@/lib/format";
import {
  ALL_TRACK_HORIZONS,
  DEFAULT_TRACK_HORIZON,
  OUTCOME_SHORT,
  TRACK_BENCHMARK,
  getMemberTrack,
  percent,
  points,
  shortfall,
  type MemberTrack as MemberTrackData,
  type TrackDecisionRow,
  type TrackScoreRow,
} from "@/lib/track-queries";
import { Card, SectionTitle, StatTile } from "../../charts";
import { Disclosure } from "../../disclosure";
import { DataError, Quiet } from "../../page-header";
import { TRACK_PATH } from "../../politicians/track-view";
import { ActionBadge, ResponsiveTable, TickerChip } from "../../ui";
import { IntervalBar, Points, intervalText } from "../../track-ui";
import { DATA_TABLE, PLAIN_HEAD_ROW, PLAIN_BODY_ROW } from "../../sortable-table";

/*
 * A member's track record (CLAUDE.md, "Track record"): read from the tables
 * the pipeline derives once in Python, never computed here. The framing is
 * the leaderboard's — how the stocks they traded moved afterwards against
 * the S&P 500, never their profit — and every caveat lives on the
 * leaderboard's "How to read this", linked from here.
 */

const LIST = 5;

export async function MemberTrack({ member }: { member: string }) {
  let data: MemberTrackData;
  try {
    data = await getMemberTrack(member);
  } catch (err) {
    return (
      <section>
        <SectionTitle>Track record</SectionTitle>
        <DataError error={err} context="Track record unavailable" />
      </section>
    );
  }
  const title = (
    <SectionTitle right={<a href={TRACK_PATH} className="underline decoration-border-strong underline-offset-[3px] hover:text-foreground">All members ›</a>}>
      <span id="track-title">Track record</span>
    </SectionTitle>
  );
  if (!data.available || data.min_decisions == null) {
    return (
      <section aria-labelledby="track-title" data-track-member="computing">
        {title}
        <Card>
          <Quiet>
            Track record is being computed. The pipeline measures how the stocks each member traded moved against the
            S&amp;P 500 after each run; this section fills in once it has.
          </Quiet>
        </Card>
      </section>
    );
  }

  const main = data.scores.find((s) => s.horizon === DEFAULT_TRACK_HORIZON);
  const minimum = data.min_decisions ?? main?.min_decisions ?? 0;
  const lead = (
    <Disclosure
      size="sm"
      className="mt-3 sm:mt-4"
      lead={
        <>
          How each stock moved after this member traded it, against the S&amp;P 500 ({TRACK_BENCHMARK}) over the same
          trading days, read the way the trade pointed — the stock&rsquo;s move, not their profit. No dollar amount
          enters it. Not advice, and not evidence of wrongdoing.{" "}
          <a href={TRACK_PATH} className="underline decoration-border-strong underline-offset-[3px] hover:text-foreground">
            How to read the track record
          </a>
          .
        </>
      }
    />
  );

  if (!main || !main.qualifies) {
    const n30 = data.scores.find((s) => s.horizon === 30);
    return (
      <section aria-labelledby="track-title" data-track-member="below-minimum" className="space-y-3 sm:space-y-4">
        {title}
        <Card>
          <p className="text-[15px] font-semibold text-foreground">Not enough matured trades yet</p>
          <p className="mt-1 text-[14px] text-ink-2">
            Measured over {DEFAULT_TRACK_HORIZON} trading days: {main ? shortfall(main) : `0 of ${minimum} decisions`}{" "}
            needed to be ranked
            {n30 ? ` (${n30.n} decisions over 30 days${n30.qualifies && n30.rank ? `, ranked #${n30.rank} of ${data.ranked_count[30] ?? "?"}` : ""})` : ""}
            {data.pending ? `; ${data.pending} more waiting for the horizon to pass` : ""}.
          </p>
          <Excluded data={data} />
          {lead}
        </Card>
        {n30?.qualifies ? <ScoreTable scores={data.scores} /> : null}
      </section>
    );
  }

  const best = data.decisions.slice(0, LIST);
  const remaining = data.decisions.slice(LIST);
  const worst = remaining.length ? remaining.slice(-LIST).reverse() : [];
  const ranked = data.ranked_count[DEFAULT_TRACK_HORIZON];

  return (
    <section aria-labelledby="track-title" data-track-member="ranked">
      {title}
      <div className="space-y-3 sm:space-y-4">
        <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
          <StatTile
            label="After the trade"
            value={`${points(main.trade.score)} pts`}
            hint={`vs S&P 500 · ${DEFAULT_TRACK_HORIZON} trading days · rank ${main.rank} of ${ranked ?? "?"}`}
          />
          <StatTile
            label="After disclosure"
            value={`${points(main.disclosure.score)} pts`}
            hint={`${points(main.trade.score - main.disclosure.score)} pts lost to the disclosure delay`}
          />
          <StatTile label="Hit rate" value={percent(main.trade.hit_rate)} hint={`of ${main.n} decisions · ${main.filings} filings`} />
          <StatTile
            label="Luck check"
            value={main.trade.luck == null ? "—" : `${percent(main.trade.luck)}`}
            hint="of same-date random picks beaten"
          />
        </div>
        <ScoreTable scores={data.scores} />
        <Card>
          {best.length ? (
            <div className="grid gap-6 lg:grid-cols-2">
              <DecisionList title="Best-timed" rows={best} />
              {worst.length ? <DecisionList title="Worst-timed" rows={worst} /> : null}
            </div>
          ) : null}
          <Excluded data={data} />
          {lead}
        </Card>
      </div>
    </section>
  );
}

function ScoreTable({ scores }: { scores: TrackScoreRow[] }) {
  const shown = ALL_TRACK_HORIZONS.map((h) => scores.find((s) => s.horizon === h)).filter(
    (s): s is TrackScoreRow => !!s
  );
  const scale = Math.max(
    0.01,
    ...shown.flatMap((s) => [s.trade, s.disclosure]).flatMap((c) => [Math.abs(c.lo ?? c.score), Math.abs(c.hi ?? c.score)])
  );
  return (
    <div>
      <ResponsiveTable>
        <table className={DATA_TABLE} data-track-scores>
          <thead>
            <tr className={PLAIN_HEAD_ROW}>
              <th scope="col" className="px-4 py-3 font-medium">
                Horizon
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                Clock
              </th>
              <th scope="col" className="px-4 py-3 text-right font-medium">
                Score
              </th>
              <th scope="col" className="w-44 px-4 py-3 font-medium text-center">
                90% interval
              </th>
              <th scope="col" className="px-4 py-3 text-right font-medium">
                Hit rate
              </th>
              <th scope="col" className="px-4 py-3 text-right font-medium">
                Luck check
              </th>
              <th scope="col" className="px-4 py-3 text-right font-medium">
                Decisions
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.flatMap((s) =>
              (["trade", "disclosure"] as const).map((clock) => {
                const c = s[clock];
                return (
                  <tr key={`${s.horizon}-${clock}`} className={PLAIN_BODY_ROW}>
                    <td className="tabular px-4 py-2.5 font-medium text-foreground">{clock === "trade" ? `${s.horizon} days` : ""}</td>
                    <td className="px-4 py-2.5 text-ink-2">{clock === "trade" ? "After the trade" : "After disclosure"}</td>
                    <td className="px-4 py-2.5 text-right font-semibold text-foreground">
                      {s.qualifies ? <Points value={c.score} /> : <span className="font-normal text-muted-foreground text-[12px]">not enough yet</span>}
                    </td>
                    <td className="px-4 py-2.5">
                      {s.qualifies ? (
                        <div className="flex flex-col items-center">
                          <IntervalBar
                            score={c.score}
                            lo={c.lo}
                            hi={c.hi}
                            scale={scale}
                            label={`${points(c.score)} points, 90% interval ${intervalText(c.lo, c.hi)}`}
                          />
                          <div className="tabular mt-1 text-center text-[11px] text-muted-foreground">{intervalText(c.lo, c.hi)}</div>
                        </div>
                      ) : null}
                    </td>
                    <td className="tabular px-4 py-2.5 text-right font-medium text-foreground/90">{s.qualifies ? percent(c.hit_rate) : "—"}</td>
                    <td
                      className="tabular px-4 py-2.5 text-right text-ink-2"
                      title={c.luck == null && s.qualifies ? "Too few other members traded on these dates to compare with" : undefined}
                    >
                      {c.luck == null ? (
                        s.qualifies ? <span className="text-muted-foreground">n/a</span> : "—"
                      ) : (
                        <>
                          <span className="mr-1 text-[11px] text-muted-foreground">beats</span>
                          <span className="font-medium text-foreground">{percent(c.luck)}</span>
                        </>
                      )}
                    </td>
                    <td className="tabular px-4 py-2.5 text-right text-muted-foreground">
                      {clock === "trade" ? `${s.n} of ${s.min_decisions}+` : ""}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </ResponsiveTable>
      <p className="mt-2.5 pl-1 text-[12px] text-muted-foreground">
        Score: average move vs the S&amp;P 500 in points, shrunk toward zero for small samples. Both clocks use the same
        decisions.
      </p>
    </div>
  );
}

function DecisionList({ title, rows }: { title: string; rows: TrackDecisionRow[] }) {
  return (
    <div>
      <h3 className="mb-2 text-[15px] font-semibold text-foreground">
        {title}{" "}
        <span className="text-[12px] font-normal text-muted-foreground">over {DEFAULT_TRACK_HORIZON} trading days</span>
      </h3>
      <ul className="inset-rows text-[13px]" data-track-decisions={title}>
        {rows.map((r, index) => (
          <li
            key={`${r.ticker}-${r.direction}-${r.tx_date}-${r.filing_date ?? index}`}
            className="flex min-h-11 items-center justify-between gap-3 py-2 px-1 rounded-control transition-colors duration-(--dur-fast) hover:bg-fill/40"
          >
            <span className="flex min-w-0 items-center gap-2">
              <TickerChip ticker={r.ticker} href={tickerHref(r.ticker)} />
              <ActionBadge action={r.direction === "buy" ? "purchase" : "sale"} />
              <span className="hidden truncate text-muted-foreground sm:inline" title={`Traded ${r.tx_date}, filed ${r.filing_date ?? "?"}`}>
                {shortDate(r.tx_date)}
              </span>
            </span>
            <span
              className="flex shrink-0 flex-col items-end text-right sm:flex-row sm:items-baseline"
              title={`${r.ticker} vs ${TRACK_BENCHMARK} from the ${r.t0_trade} close: ${points(r.trade)} points after the trade, ${points(r.disclosure)} after disclosure (from ${r.t0_disclosure})`}
            >
              <Points value={r.trade} className="font-semibold text-foreground" />
              <span className="text-[12px] text-muted-foreground sm:ml-2.5">
                {points(r.disclosure)} after disclosure
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Excluded({ data }: { data: MemberTrackData }) {
  if (!data.excluded.length) return null;
  return (
    <p className="mt-4 text-[12px] leading-relaxed text-muted-foreground">
      Decisions not measured:{" "}
      {data.excluded
        .map((e) => `${OUTCOME_SHORT[e.outcome] ?? e.outcome} (${e.decisions})`)
        .join(" · ")}
      .
    </p>
  );
}
