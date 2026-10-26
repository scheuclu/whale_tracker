import { memberHref } from "@/lib/format";
import { absoluteUrl, plural } from "@/lib/site";
import {
  COVERAGE_SUBSETS,
  OUTCOME_LABEL,
  TRACK_BENCHMARK,
  TRACK_HORIZONS,
  getTrackLeaderboard,
  percent,
  points,
  shortfall,
  type TrackHorizon,
  type TrackLeaderboard,
  type TrackScoreRow,
} from "@/lib/track-queries";
import { Card, SectionTitle, StatTile } from "../charts";
import { MemberAvatar } from "../avatar";
import { Disclosure } from "../disclosure";
import { DataError, PAGE_STACK, PageHeader, Quiet } from "../page-header";
import { ShareControl } from "../share-control";
import { PartyBadge, ResponsiveTable, Segmented } from "../ui";
import { IntervalBar, Points, intervalText } from "../track-ui";

/*
 * `/rankings` (was `/politicians?view=track`) — the members' track record (CLAUDE.md, "Track
 * record"). Every figure is read from tables the pipeline derives once in
 * Python; this page computes no score. The framing is fixed: "whose trades
 * were followed by the biggest market-beating moves" — a stock's move after
 * a disclosed trade, never anyone's profit, return or skill.
 */

export const TRACK_PATH = "/rankings";

export function trackHref(horizon: TrackHorizon): string {
  return horizon === 90 ? TRACK_PATH : `${TRACK_PATH}?h=${horizon}`;
}

/** Every caveat, once (DESIGN.md: "state the caveat once, well"). */
export function TrackCaveats({ minimum, minFilings, k }: { minimum: number | null; minFilings: number | null; k: number | null }) {
  return (
    <Disclosure
      lead={
        <>
          Each figure is how a stock moved after a member traded it, against the S&amp;P 500 ({TRACK_BENCHMARK}) over
          the same trading days — the stock&rsquo;s move, not the member&rsquo;s profit. Not investment advice, and a
          disclosed trade is not evidence of wrongdoing.
        </>
      }
    >
      <p>
        <strong className="font-semibold text-ink-2">What is measured.</strong> A decision is one member, one ticker,
        one direction, one filing: thirty rows for one stock in one report count once. For each, the stock&rsquo;s
        close-to-close move over 30 or 90 trading days minus {TRACK_BENCHMARK}&rsquo;s over the same days, read the way
        the trade pointed — a sale followed by a fall scores positive. Closes are split-adjusted; dividends are ignored
        on both sides.
      </p>
      <p>
        <strong className="font-semibold text-ink-2">Two clocks.</strong> &ldquo;After the trade&rdquo; starts at the
        first close on or after the trade date. &ldquo;After disclosure&rdquo; starts at the first close after the
        report was filed — the earliest a member of the public could have copied it. Both are measured on the same
        decisions; the gap is the move that happened before anyone could see the trade.
      </p>
      <p>
        <strong className="font-semibold text-ink-2">What is unknown.</strong> When or whether the position was sold,
        and its size: amounts are disclosed brackets, so no dollar figure enters this and every decision counts once.
        Options, bonds, Treasuries, funds and exchanges are left out, as are rows read from scanned paper filings and
        rows whose filed dates contradict each other — the counts are under &ldquo;Coverage&rdquo;. Tickers with no
        price series (delisted, renamed or acquired companies) drop out, which flatters whoever held the survivors.
      </p>
      <p>
        <strong className="font-semibold text-ink-2">Small samples are pulled toward zero.</strong> A member&rsquo;s
        average is shrunk toward zero by n / (n + k)
        {k != null ? <>, with k = {k.toFixed(0)} estimated from how much members differ beyond chance</> : null}: a
        handful of lucky picks cannot top the table. The bar is a 90% interval from re-drawing the member&rsquo;s
        filings at random; when it crosses zero the data cannot tell the record from no edge at all. Members need at
        least {minimum ?? "the minimum number of"} measured decisions, from at least {minFilings ?? "a few"} separate
        filings, to be ranked: one report is one moment in the market, however many tickers it lists.
      </p>
      <p>
        <strong className="font-semibold text-ink-2">The luck check.</strong> &ldquo;Beats 87%&rdquo; means the
        member&rsquo;s average was higher than 87% of random portfolios with the same dates and buy/sell mix, each
        ticker swapped for one another member traded that week. It is a comparison, not a probability that the record
        is skill.
      </p>
      <p>
        <strong className="font-semibold text-ink-2">Recent trades are missing.</strong> A decision counts only once
        its horizon has passed on both clocks, so the most recent months are not in the table yet.
      </p>
    </Disclosure>
  );
}

export async function TrackView({ horizon, nav }: { horizon: TrackHorizon; nav?: React.ReactNode }) {
  let board: TrackLeaderboard;
  try {
    board = await getTrackLeaderboard(horizon);
  } catch (err) {
    return <DataError error={err} />;
  }
  const model = board.model.trade;
  const header = (
    <PageHeader
      lead={nav}
      share={<ShareControl url={absoluteUrl(TRACK_PATH)} text="Members of Congress whose trades were followed by the biggest market-beating moves" />}
      eyebrow="Congress · track record"
      title="Track record"
      subtitle={
        <>
          Whose trades were followed by the biggest market-beating moves: how each stock moved after a member traded
          it, against the S&amp;P 500.
        </>
      }
      aside={
        <Segmented
          label="Horizon"
          items={TRACK_HORIZONS.map((h) => ({
            key: String(h),
            label: `${h} trading days`,
            href: trackHref(h),
            active: h === horizon,
          }))}
        />
      }
    >
      <TrackCaveats minimum={board.min_decisions} minFilings={board.min_filings} k={model?.k ?? null} />
      {board.available && model ? <TrackTiles board={board} /> : null}
    </PageHeader>
  );

  if (!board.available || !model) {
    return (
      <div className={PAGE_STACK}>
        {header}
        <Card>
          <Quiet>
            Track record is being computed. The pipeline measures every member&rsquo;s trades against the S&amp;P 500
            after each run; the first full pass takes a few runs
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

  return (
    <div className={PAGE_STACK}>
      {header}

      <section aria-labelledby="ranked-title">
        <SectionTitle
          kicker="Leaderboard"
          right={
            <span className="text-[11px] text-muted-foreground">
              {plural(board.ranked.length, "member")} · {board.min_decisions}+ decisions over {board.min_filings}+ filings
            </span>
          }
        >
          <span id="ranked-title">Ranked over {horizon} trading days</span>
        </SectionTitle>
        {board.ranked.length ? (
          <RankedTable rows={board.ranked} horizon={horizon} scale={scale} />
        ) : (
          <Card>
            <Quiet>No member has {board.min_decisions} measured decisions at this horizon yet.</Quiet>
          </Card>
        )}
      </section>

      <UnrankedList rows={board.unranked} minimum={board.min_decisions ?? 0} minFilings={board.min_filings ?? 0} horizon={horizon} />

      <CoverageSection board={board} />
    </div>
  );
}

function TrackTiles({ board }: { board: TrackLeaderboard }) {
  const t = board.model.trade!;
  const d = board.model.disclosure;
  const measured = board.coverage.find((c) => c.outcome === "included")?.decisions ?? 0;
  const candidates = board.coverage.filter((c) => !COVERAGE_SUBSETS.has(c.outcome)).reduce((s, c) => s + c.decisions, 0);
  return (
    <section aria-label="Track record totals" className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
      <StatTile label="Members ranked" value={String(t.ranked)} hint={`of ${t.members} with a measured decision`} />
      <StatTile
        label="Decisions measured"
        value={t.decisions.toLocaleString()}
        hint={`both clocks past ${board.horizon} trading days`}
      />
      <StatTile
        label="All members, after the trade"
        value={`${points(t.mean)} pts`}
        hint={`average decision vs ${TRACK_BENCHMARK} · unshrunk`}
      />
      <StatTile
        label="All members, after disclosure"
        value={`${points(d?.mean ?? null)} pts`}
        hint={`${measured.toLocaleString()} of ${candidates.toLocaleString()} candidate decisions eligible`}
      />
    </section>
  );
}

function RankedTable({ rows, horizon, scale }: { rows: TrackScoreRow[]; horizon: TrackHorizon; scale: number }) {
  return (
    <ResponsiveTable>
      <table className="w-full text-[13px]" data-track-ranked>
        <thead>
          <tr className="text-left text-[12px] font-medium text-muted-foreground">
            <th scope="col" className="px-4 py-2.5 font-medium">
              Member
            </th>
            <th scope="col" className="px-4 py-2.5 text-right font-medium" title="Shrunk average move vs the S&P 500 after the trade date">
              After the trade
            </th>
            <th scope="col" className="w-48 px-4 py-2.5 font-medium" title="90% bootstrap interval of the score; the hairline is zero">
              90% interval
            </th>
            <th scope="col" className="px-4 py-2.5 text-right font-medium" title="Share of decisions followed by a market-beating move in the trade's direction">
              Hit rate
            </th>
            <th scope="col" className="px-4 py-2.5 text-right font-medium" title="Decisions measured (filings)">
              Decisions
            </th>
            <th scope="col" className="px-4 py-2.5 text-right font-medium" title="The same score from the first close after the filing date">
              After disclosure
            </th>
            <th scope="col" className="px-4 py-2.5 text-right font-medium" title="Share of same-date random portfolios this member's average beats">
              Luck check
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const href = memberHref(r.member_name, r.bioguide_id);
            const label = `${r.member_name}: ${points(r.trade.score)} points vs ${TRACK_BENCHMARK} over ${horizon} trading days after the trade (shrunk; unshrunk average ${points(r.trade.mean)}), 90% interval ${intervalText(r.trade.lo, r.trade.hi)}`;
            return (
              <tr key={r.member_name} className="group border-t border-border transition-colors hover:bg-fill/45" data-track-row={r.rank ?? undefined}>
                <th scope="row" className="px-4 py-2.5 text-left font-normal">
                  <div className="flex items-center gap-2.5">
                    <span className="tabular w-5 shrink-0 text-right text-[12px] font-medium text-muted-foreground">{r.rank}</span>
                    <MemberAvatar name={r.member_name} bioguideId={r.bioguide_id} size="sm" />
                    <a href={href} className="row-name max-w-[7.5rem] truncate font-semibold tracking-[-0.01em] sm:max-w-none" title={r.member_name}>
                      {r.member_name}
                    </a>
                    <span className="hidden sm:inline-flex">
                      <PartyBadge party={r.party} />
                    </span>
                  </div>
                </th>
                <td className="px-4 py-2.5 text-right font-semibold text-foreground">
                  <Points value={r.trade.score} />
                </td>
                <td className="px-4 py-2.5">
                  <IntervalBar score={r.trade.score} lo={r.trade.lo} hi={r.trade.hi} scale={scale} label={label} />
                  <div className="tabular mt-0.5 text-[11px] text-muted-foreground">{intervalText(r.trade.lo, r.trade.hi)}</div>
                </td>
                <td className="tabular px-4 py-2.5 text-right text-ink-2">{percent(r.trade.hit_rate)}</td>
                <td className="tabular px-4 py-2.5 text-right text-ink-2">
                  {r.n}
                  <span className="text-muted-foreground"> · {plural(r.filings, "filing")}</span>
                </td>
                <td className="px-4 py-2.5 text-right text-ink-2" title={`Timing lost to the disclosure delay: ${points(r.trade.score - r.disclosure.score)} points`}>
                  <Points value={r.disclosure.score} />
                </td>
                <td
                  className="tabular px-4 py-2.5 text-right text-ink-2"
                  title={
                    r.trade.luck == null
                      ? "No luck check: too few other members traded on this member's dates to compare with (old catch-up filings)"
                      : "Share of random portfolios on the same dates, with the same buy/sell mix, that this member's average beats"
                  }
                >
                  {r.trade.luck == null ? "n/a" : `beats ${percent(r.trade.luck)}`}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </ResponsiveTable>
  );
}

function UnrankedList({
  rows,
  minimum,
  minFilings,
  horizon,
}: {
  rows: TrackScoreRow[];
  minimum: number;
  minFilings: number;
  horizon: TrackHorizon;
}) {
  if (!rows.length) return null;
  return (
    <section aria-labelledby="unranked-title">
      <SectionTitle
        kicker="Below threshold"
        right={<span className="text-[11px] text-muted-foreground">what each still needs</span>}
      >
        <span id="unranked-title">Not enough matured trades yet</span>
      </SectionTitle>
      <Card>
        <p className="mb-3.5 text-[13px] text-muted-foreground">
          {plural(rows.length, "member")} with fewer than {minimum} decisions measured over {horizon} trading days, or
          fewer than {minFilings} filings behind them. Listed, never ranked.
        </p>
        <ul className="flex flex-wrap gap-x-2 gap-y-2" data-track-unranked>
          {rows.map((r) => (
            <li key={r.member_name}>
              <a
                href={memberHref(r.member_name, r.bioguide_id)}
                className="inline-flex h-7 items-center gap-1.5 rounded-full bg-fill/85 pl-1 pr-3 text-[12px] font-medium text-ink-2 ring-1 ring-black/[0.04] transition-all duration-(--dur) hover:bg-foreground/[0.09] hover:text-foreground dark:ring-white/[0.08]"
              >
                <MemberAvatar name={r.member_name} bioguideId={r.bioguide_id} size="xs" />
                {r.member_name}
                <span className="tabular font-normal text-muted-foreground">{shortfall(r)}</span>
              </a>
            </li>
          ))}
        </ul>
      </Card>
    </section>
  );
}

function CoverageSection({ board }: { board: TrackLeaderboard }) {
  if (!board.coverage.length) return null;
  const totalRows = board.coverage.filter((c) => !COVERAGE_SUBSETS.has(c.outcome)).reduce((s, c) => s + c.rows, 0);
  const included = board.coverage.find((c) => c.outcome === "included");
  return (
    <section aria-labelledby="coverage-title">
      <SectionTitle
        kicker="Data accounting"
        right={
          <span className="text-[11px] text-muted-foreground">
            {included ? `${percent(included.rows / (totalRows || 1))} of counted trades eligible` : null}
          </span>
        }
      >
        <span id="coverage-title">Coverage</span>
      </SectionTitle>
      <ResponsiveTable stickyFirstColumn={false} wrap>
        <table className="w-full text-[13px]" data-track-coverage>
          <thead>
            <tr className="text-left text-[12px] font-medium text-muted-foreground">
              <th scope="col" className="px-4 py-2.5 font-medium">
                Counted trades
              </th>
              <th scope="col" className="px-4 py-2.5 text-right font-medium">
                Rows
              </th>
              <th scope="col" className="px-4 py-2.5 text-right font-medium" title="Member, ticker, direction and filing">
                Decisions
              </th>
            </tr>
          </thead>
          <tbody>
            {board.coverage.map((c) => (
              <tr key={c.outcome} className="border-t border-border">
                <th
                  scope="row"
                  className={`px-4 py-2 text-left font-normal ${COVERAGE_SUBSETS.has(c.outcome) ? "pl-8 text-muted-foreground" : "text-ink-2"}`}
                >
                  {OUTCOME_LABEL[c.outcome] ?? c.outcome}
                </th>
                <td className="tabular px-4 py-2 text-right">{c.rows.toLocaleString()}</td>
                <td className="tabular px-4 py-2 text-right">{c.decisions ? c.decisions.toLocaleString() : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </ResponsiveTable>
      <Quiet className="mt-3 text-[12px]">
        Rows without a ticker or a direction form no decision, so their decision count is blank. Data as of the
        pipeline&rsquo;s last track-record pass
        {board.computed_at ? ` (${board.computed_at.slice(0, 10)})` : ""}
        {board.status && !board.status.startsWith("ok") ? `; last run: ${board.status}` : ""}.
      </Quiet>
    </section>
  );
}
