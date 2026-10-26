import { getInsiderTrackLeaderboard, type InsiderTrackLeaderboard, type InsiderTrackScoreRow } from "@/lib/insider-track-queries";
import { TRACK_BENCHMARK, TRACK_HORIZONS, points, type TrackHorizon } from "@/lib/track-queries";
import { insiderHref, insiderIssuerHref } from "@/lib/format";
import { longDate } from "@/lib/members";
import { absoluteUrl, plural } from "@/lib/site";
import { Card, SectionTitle, StatTile } from "../charts";
import { ResponsiveTable, Segmented, TickerChip } from "../ui";
import { DataError, PAGE_STACK, PageHeader, Quiet } from "../page-header";
import { ShareControl } from "../share-control";
import { Disclosure } from "../disclosure";
import { IntervalBar, Points, intervalText, luckText } from "../track-ui";

/**
 * `/rankings?view=insiders` — the corporate insiders' track record: the
 * members' measurement, run on Form 4 filers in tables of their own, and a
 * leaderboard of its own. Never merged with the members' ranking (CLAUDE.md,
 * "Track record" → "Insiders later"). Read-only, like the members' view.
 */
export const INSIDER_TRACK_PATH = "/rankings?view=insiders";

function horizonHref(h: TrackHorizon): string {
  return h === 90 ? INSIDER_TRACK_PATH : `${INSIDER_TRACK_PATH}&h=${h}`;
}

/** The first 90-trading-day horizon of the history: about 130 calendar days after it starts. */
function firstMaturity(historyFrom: string | null, horizon: TrackHorizon): string | null {
  if (!historyFrom) return null;
  const d = new Date(`${historyFrom}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Math.ceil(horizon * 1.45));
  return d.toISOString().slice(0, 10);
}

export async function InsiderTrackView({ horizon, nav }: { horizon: TrackHorizon; nav?: React.ReactNode }) {
  let board: InsiderTrackLeaderboard;
  try {
    board = await getInsiderTrackLeaderboard(horizon);
  } catch (err) {
    return <DataError error={err} />;
  }
  const model = board.model.trade;
  const header = (
    <PageHeader
      lead={nav}
      share={<ShareControl url={absoluteUrl(INSIDER_TRACK_PATH)} text="Corporate insiders whose trades were followed by the biggest market-beating moves" />}
      eyebrow="Corporate insiders · track record"
      title="Insider track record"
      subtitle={
        <>
          How each insider&apos;s company stock moved after they traded it, against the S&amp;P 500. A ranking of its
          own, never mixed with the members&apos;.
        </>
      }
      aside={
        <Segmented
          label="Horizon"
          items={TRACK_HORIZONS.map((h) => ({ key: String(h), label: `${h} trading days`, href: horizonHref(h), active: h === horizon }))}
        />
      }
    >
      <Disclosure
        lead={
          <>
            Each figure is how a stock moved after an insider traded it, against the S&amp;P 500 ({TRACK_BENCHMARK}) over
            the same trading days — the stock&apos;s move, not the insider&apos;s profit. Insiders trade their own company
            under plans and blackout windows it sets; a strong record is not evidence of anything.
          </>
        }
      >
        <p>
          One decision is one Form 4&apos;s buys or sells of one stock by its primary reporting owner (a joint filing is
          one decision), dated by its earliest trade. Scores are shrunk toward zero for small samples; an insider is
          ranked once they have {board.min_decisions ?? 8} matured decisions over {board.min_filings ?? 3} filings, with
          a 90% interval and a luck check against other insiders&apos; trades on the same dates. Only filings of $50k
          or more in one direction are stored, so small trades are not in it.
        </p>
      </Disclosure>
      {board.available && model ? <Tiles board={board} /> : null}
    </PageHeader>
  );

  if (!board.available || !model) {
    return (
      <div className={PAGE_STACK}>
        {header}
        <Card>
          <Quiet>
            The insider track record is being computed: the pipeline measures every insider&apos;s trades against the
            S&amp;P 500 after each run
            {board.status && !board.status.startsWith("ok") ? ` (last run: ${board.status})` : ""}.
          </Quiet>
        </Card>
      </div>
    );
  }

  const scale = Math.max(
    0.01,
    ...board.ranked.flatMap((r) => [Math.abs(r.trade.lo ?? r.trade.score), Math.abs(r.trade.hi ?? r.trade.score)])
  );
  const matures = firstMaturity(board.history_from, horizon);

  return (
    <div className={PAGE_STACK}>
      {header}
      <section>
        <SectionTitle
          kicker="Leaderboard"
          right={
            <span className="text-[11px] text-muted-foreground">
              {plural(board.ranked.length, "insider")} · {board.min_decisions}+ decisions over {board.min_filings}+ filings
            </span>
          }
        >
          Ranked over {horizon} trading days
        </SectionTitle>
        {board.ranked.length ? (
          <RankedTable rows={board.ranked} horizon={horizon} scale={scale} />
        ) : (
          <Card>
            <Quiet>
              No insider has {board.min_decisions} matured decisions over {board.min_filings} filings at this horizon yet
              {board.unranked ? `; ${plural(board.unranked, "insider")} ${board.unranked === 1 ? "is" : "are"} measured and waiting` : ""}.
              {board.history_from ? (
                <>
                  {" "}The stored Form 4 history starts {longDate(board.history_from)}
                  {matures ? `, so ${horizon}-trading-day horizons begin to mature around ${longDate(matures)}` : ""}.
                </>
              ) : null}{" "}
              Nobody is ranked below the minimum: a short record says nothing reliable.
            </Quiet>
          </Card>
        )}
      </section>
    </div>
  );
}

function Tiles({ board }: { board: InsiderTrackLeaderboard }) {
  const t = board.model.trade!;
  const d = board.model.disclosure;
  return (
    <section aria-label="Insider track record totals" className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
      <StatTile label="Insiders ranked" value={String(t.ranked)} hint={`of ${t.members} with a measured decision`} />
      <StatTile label="Decisions measured" value={t.decisions.toLocaleString()} hint={`both clocks past ${board.horizon} trading days`} />
      <StatTile
        label="All insiders, after the trade"
        value={t.mean == null ? "—" : `${points(t.mean)} pts`}
        hint={`average decision vs ${TRACK_BENCHMARK} · unshrunk`}
      />
      <StatTile
        label="All insiders, after the filing"
        value={d?.mean == null ? "—" : `${points(d.mean)} pts`}
        hint="from the first close after the Form 4"
      />
    </section>
  );
}

function RankedTable({ rows, horizon, scale }: { rows: InsiderTrackScoreRow[]; horizon: TrackHorizon; scale: number }) {
  return (
    <ResponsiveTable>
      <table className="w-full text-[13px]" data-insider-track-ranked>
        <thead>
          <tr className="text-left text-[12px] font-medium text-muted-foreground">
            <th scope="col" className="px-4 py-2.5 font-medium">Insider</th>
            <th scope="col" className="px-4 py-2.5 text-right font-medium">After the trade</th>
            <th scope="col" className="w-48 px-4 py-2.5 font-medium">90% interval</th>
            <th scope="col" className="px-4 py-2.5 text-right font-medium">Hit rate</th>
            <th scope="col" className="px-4 py-2.5 text-right font-medium">Decisions</th>
            <th scope="col" className="px-4 py-2.5 text-right font-medium">After the filing</th>
            <th scope="col" className="px-4 py-2.5 text-right font-medium">Luck check</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const name = r.name ?? `CIK ${r.cik}`;
            const label = `${name}: ${points(r.trade.score)} points vs ${TRACK_BENCHMARK} over ${horizon} trading days after the trade, 90% interval ${intervalText(r.trade.lo, r.trade.hi)}`;
            return (
              <tr key={r.cik} className="group border-t border-border transition-colors hover:bg-fill/45">
                <th scope="row" className="px-4 py-2.5 text-left font-normal">
                  <div className="flex items-center gap-2.5">
                    <span className="tabular w-5 shrink-0 text-right text-[12px] font-medium text-muted-foreground">{r.rank}</span>
                    <a href={insiderHref(r.name, r.cik)} className="row-name max-w-[9rem] truncate font-semibold sm:max-w-none" title={name}>
                      {name}
                    </a>
                    {r.latest_ticker ? <TickerChip ticker={r.latest_ticker} href={insiderIssuerHref(r.latest_ticker)} /> : null}
                  </div>
                </th>
                <td className="px-4 py-2.5 text-right font-semibold text-foreground">
                  <Points value={r.trade.score} />
                </td>
                <td className="px-4 py-2.5">
                  <IntervalBar score={r.trade.score} lo={r.trade.lo} hi={r.trade.hi} scale={scale} label={label} />
                  <div className="tabular mt-0.5 text-[11px] text-muted-foreground">{intervalText(r.trade.lo, r.trade.hi)}</div>
                </td>
                <td className="tabular px-4 py-2.5 text-right">{Math.round(r.trade.hit_rate * 100)}%</td>
                <td className="tabular px-4 py-2.5 text-right">
                  {r.n} <span className="text-muted-foreground">· {plural(r.filings, "filing")}</span>
                </td>
                <td className="px-4 py-2.5 text-right">
                  <Points value={r.disclosure.score} />
                </td>
                <td className="tabular px-4 py-2.5 text-right text-muted-foreground">{luckText(r.trade.luck)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </ResponsiveTable>
  );
}
