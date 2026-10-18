import {
  STOCK_ACT_DEADLINE_DAYS,
  getCommittee,
  getCommitteeMembers,
  getLateFilings,
  getLateMembers,
  getLateMonthly,
  getLateTotals,
  getPoliticianTotals,
  getPoliticians,
  getSubcommittees,
} from "@/lib/queries";
import type { Metadata } from "next";
import { committeeHref, memberHref, range, shortDate, usd } from "@/lib/format";
import { plural } from "@/lib/site";
import { clip, pageMetadata } from "@/lib/seo";
import { Card, ColumnSeries, Empty, SectionTitle, StatTile, VOLUME_NOTE } from "../charts";
import { ActionBadge, Amount, DelayTag, OwnerTag, PartyBadge, ResponsiveTable, ScanTag, TickerChip } from "../ui";
import { MemberAvatar } from "../avatar";
import { MemberBars } from "./member-bars";
import { CHAMBER_LABEL, SeatTag } from "../members/[slug]/member-detail";
import { POLITICIAN_SORT, isDefaultSort, parseSort, type PoliticianSortKey } from "@/lib/table-sort";
import { BODY_ROW, BarCell, DATA_TABLE, HEAD_ROW, LateCell, SortHeader, SplitCell, sortHref } from "../sortable-table";
import { RowLinkBody, StickyThead } from "../table-client";

export const dynamic = "force-dynamic";

type Params = { action?: string; committee?: string; view?: string; sort?: string; dir?: string };

/**
 * Three pages share this route: the roster, `?view=late` and
 * `?committee=<id>`. Each canonicalises to itself with only the parameter
 * that defines it; a sorted roster is the roster, so its canonical is the
 * bare path.
 */
export async function generateMetadata({ searchParams }: { searchParams: Promise<Params> }): Promise<Metadata> {
  const params = await searchParams;
  if (params.view === "late") {
    return pageMetadata({
      title: "Late STOCK Act disclosures by member of Congress",
      description:
        "Members of Congress ranked by trades disclosed more than 45 days after the trade, the STOCK Act deadline, with the filings behind each count. A reporting fact, not an allegation.",
      path: "/politicians?view=late",
    });
  }
  if (params.committee) {
    const path = `/politicians?committee=${encodeURIComponent(params.committee)}`;
    let name: string | null = null;
    let seats = 0;
    try {
      const [committee, members] = await Promise.all([getCommittee(params.committee), getCommitteeMembers(params.committee)]);
      name = committee?.name ?? null;
      seats = members.length;
    } catch {
      /* metadata degrades to the id */
    }
    if (!name) {
      return pageMetadata({ title: `Committee ${params.committee}`, description: "No such committee.", path, noindex: true });
    }
    return pageMetadata({
      title: `${name}: members' stock trades`,
      description: clip(
        `Stock trades disclosed by the ${plural(seats, "member")} seated on the ${name}, from House and Senate STOCK Act filings, with each seat holder's trade count and disclosed range.`
      ),
      path,
    });
  }
  let members = 0;
  try {
    members = (await getPoliticianTotals()).members;
  } catch {
    /* generic copy below */
  }
  return pageMetadata({
    title: "Members of Congress trading stocks",
    description: `${members ? `${plural(members, "member")} of Congress` : "Members of Congress"} with disclosed stock trades, ranked by trades, tickers, estimated volume and late filings. Amounts are the ranges filed.`,
    path: "/politicians",
  });
}

/** Every member, not a top slice: "All members" is the whole roster that has traded. */
const MEMBER_LIMIT = 2000;

// Header tooltips, in the words of the footnote under the table.
const BUYSELL_HINT = "Purchases / sales. Sorts by the share that are purchases; exchanges count as neither.";
const VOLUME_HINT =
  "Sum of disclosed bracket midpoints — an estimate, not a reported figure. An open-ended top bracket counts at its floor.";
const DELAY_HINT = "Mean days from the trade to the date the report reached the Clerk.";
const LATE_HINT =
  "Trades filed more than 45 days after the trade — the STOCK Act's deadline. A reporting fact, not an allegation of wrongdoing.";
const LAG_HINT =
  "Mean days until the member learned of the trade. A nonzero lag means someone else placed it — a spouse, a trust or a managed account — and carries no compliance meaning.";


export default async function PoliticiansPage({
  searchParams,
}: {
  searchParams: Promise<Params>;
}) {
  const params = await searchParams;
  // `?m=<name>` is answered with a 308 to /members/<slug> before it gets
  // here (next.config.ts → app/api/legacy-redirect).
  if (params.view === "late") return <LateView />;
  if (params.committee) return <CommitteeView id={params.committee} />;

  const sort = parseSort(POLITICIAN_SORT, params);
  const standing = isDefaultSort(POLITICIAN_SORT, sort);
  let rows, totals, table;
  try {
    // The charts always rank by their own measure; the table follows the
    // URL's sort, applied in SQL over every member.
    [rows, totals, table] = await Promise.all([
      getPoliticians(undefined, MEMBER_LIMIT),
      getPoliticianTotals(),
      standing ? null : getPoliticians(undefined, MEMBER_LIMIT, sort),
    ]);
  } catch (err) {
    return <Empty>{(err as Error).message}</Empty>;
  }
  if (!rows.length) return <Empty>No transactions yet.</Empty>;
  table ??= rows;

  const byTrades = [...rows].sort((a, b) => b.trades - a.trades);
  const maxVolume = Math.max(0, ...rows.map((r) => r.volume_mid));
  const maxTrades = Math.max(0, ...rows.map((r) => r.trades));
  const header = (column: PoliticianSortKey, label: string, opts: { align?: "left" | "right"; hint?: string } = {}) => (
    <SortHeader
      spec={POLITICIAN_SORT}
      sort={sort}
      column={column}
      href={sortHref(POLITICIAN_SORT, sort, column, { path: "/politicians", hash: "all-members" })}
      align={opts.align}
      hint={opts.hint}
    >
      {label}
    </SortHeader>
  );

  return (
    <div className="space-y-8">
      {/* The active tab names this page visually; the heading names it for
          screen readers and search engines without changing the layout. */}
      <h1 className="sr-only">Members of Congress trading stocks</h1>
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Members" value={String(totals.members)} hint="with disclosed trades" />
        <StatTile label="Total volume" value={usd(totals.volume_mid)} hint="estimated" />
        <a href="/politicians?view=late" className="block" title="Ranked late-filing view">
          <StatTile
            label="Late disclosures"
            value={String(totals.late_trades)}
            hint="past 45 days · ranked view →"
          />
        </a>
        <a href="/politicians?view=late" className="block" title="Ranked late-filing view">
          <StatTile
            label="Members late"
            value={String(totals.members_late)}
            hint="at least once · ranked view →"
          />
        </a>
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        <div>
          <SectionTitle>By estimated volume</SectionTitle>
          <Card>
            <MemberBars
              data={rows.slice(0, 12).map((r) => ({
                key: r.member_name,
                name: r.member_name,
                bioguideId: r.bioguide_id,
                sublabel: `${r.party ?? "?"}-${r.state ?? "?"} · ${r.trades} trade${r.trades === 1 ? "" : "s"}`,
                value: r.volume_mid,
                valueLabel: usd(r.volume_mid),
                detail:
                  r.volume_min != null
                    ? `disclosed ${range(r.volume_min, r.volume_max ?? null)}`
                    : undefined,
                href: memberHref(r.member_name, r.bioguide_id),
              }))}
              note={VOLUME_NOTE}
            />
          </Card>
        </div>
        <div>
          <SectionTitle>By number of trades</SectionTitle>
          <Card>
            <MemberBars
              data={byTrades.slice(0, 12).map((r) => ({
                key: r.member_name,
                name: r.member_name,
                bioguideId: r.bioguide_id,
                sublabel: `${r.tickers} distinct tickers`,
                value: r.trades,
                valueLabel: String(r.trades),
                href: memberHref(r.member_name, r.bioguide_id),
              }))}
            />
          </Card>
        </div>
      </section>

      <section id="all-members" className="table-anchor">
        <SectionTitle
          right={
            <span className="text-[11px] text-muted-foreground">
              {table.length} members · sort by any column
            </span>
          }
        >
          All members
        </SectionTitle>
        <ResponsiveTable>
          <table className={DATA_TABLE}>
            <StickyThead>
              <tr className={HEAD_ROW}>
                {header("member", "Member", { align: "left" })}
                {header("trades", "Trades")}
                {header("tickers", "Tickers")}
                {header("buysell", "Buy / Sell", { hint: BUYSELL_HINT })}
                {header("volume", "Volume (est.)", { hint: VOLUME_HINT })}
                {header("delay", "Delay", { hint: DELAY_HINT })}
                {header("late", "Late", { hint: LATE_HINT })}
                {header("lag", "Notify lag", { hint: LAG_HINT })}
              </tr>
            </StickyThead>
            <RowLinkBody>
              {table.map((r) => (
                <tr key={r.member_name} className={BODY_ROW} data-href={memberHref(r.member_name, r.bioguide_id)}>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <MemberAvatar name={r.member_name} bioguideId={r.bioguide_id} size="sm" />
                      <a href={memberHref(r.member_name, r.bioguide_id)} className="row-name font-medium hover:text-primary">
                        {r.member_name}
                      </a>
                      <PartyBadge party={r.party} />
                      <span className="text-[11px] text-muted-foreground">
                        {r.state}
                        {r.district && r.district !== "0" ? r.district : ""}
                      </span>
                    </div>
                  </td>
                  <BarCell value={r.trades} max={maxTrades}>
                    {r.trades}
                  </BarCell>
                  <td className="tabular px-3 py-2 text-right text-muted-foreground">{r.tickers}</td>
                  <SplitCell buys={r.buys} sells={r.sells} />
                  <BarCell
                    value={r.volume_mid}
                    max={maxVolume}
                    className={r.transcribed && !r.volume_mid ? "text-muted-foreground" : undefined}
                    title={
                      r.transcribed
                        ? `${r.transcribed} trade${r.transcribed === 1 ? "" : "s"} transcribed from scanned filings, not counted in this estimate`
                        : undefined
                    }
                  >
                    {usd(r.volume_mid)}
                  </BarCell>
                  <td className="tabular px-3 py-2 text-right text-muted-foreground">
                    {r.avg_delay == null ? "—" : `${Math.round(r.avg_delay)}d`}
                  </td>
                  <LateCell count={r.late_count} of={r.trades} />
                  <td className="tabular px-3 py-2 text-right text-muted-foreground">
                    {r.avg_lag == null ? "—" : `${Math.round(r.avg_lag)}d`}
                  </td>
                </tr>
              ))}
            </RowLinkBody>
          </table>
        </ResponsiveTable>
        <p className="mt-3 text-[11px] text-muted-foreground">
          &ldquo;Delay&rdquo; is measured from the trade to the date the report reached
          the Clerk, and &ldquo;Late&rdquo; counts trades filed more than 45 days after
          the trade — the STOCK Act&rsquo;s deadline. A late count is a reporting
          fact, not an allegation of wrongdoing. &ldquo;Notify lag&rdquo; is a
          different measure: how long until the member learned of the trade. A
          nonzero lag means someone else placed it — a spouse, a trust or a
          managed account — and carries no compliance meaning.
        </p>
      </section>
    </div>
  );
}

/** One committee's roster with each seat holder's trading totals (`?committee=HSIF`). */
async function CommitteeView({ id }: { id: string }) {
  let committee, members, subs;
  try {
    [committee, members, subs] = await Promise.all([
      getCommittee(id),
      getCommitteeMembers(id),
      getSubcommittees(id),
    ]);
  } catch (err) {
    return <Empty>{(err as Error).message}</Empty>;
  }
  if (!committee) {
    return (
      <Empty>
        No committee {id}. Committee rosters are loaded with the pipeline&rsquo;s roster
        refresh.{" "}
        <a href="/politicians" className="underline underline-offset-2 hover:text-primary">
          All members
        </a>
      </Empty>
    );
  }

  // Totals over every seat, which is the whole set for this committee — not
  // a rendered slice.
  const traders = members.filter((m) => m.trades > 0).length;
  const majority = members.filter((m) => m.side === "majority").length;
  const minority = members.filter((m) => m.side === "minority").length;
  const volume = members.reduce((s, m) => s + m.volume_mid, 0);
  const late = members.reduce((s, m) => s + m.late_count, 0);
  const transcribed = members.reduce((s, m) => s + m.transcribed, 0);
  const kind = committee.parent_id ? "subcommittee" : "committee";

  return (
    <div className="space-y-8">
      <div>
        <a href="/politicians" className="text-xs text-muted-foreground hover:text-primary">
          ← all members
        </a>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">{committee.name}</h1>
        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
          <span>
            {CHAMBER_LABEL[committee.chamber] ?? committee.chamber} {kind}
          </span>
          {committee.parent_id ? (
            <a
              href={committeeHref(committee.parent_id)}
              className="underline-offset-2 hover:text-primary hover:underline"
            >
              · of {committee.parent_name ?? committee.parent_id}
            </a>
          ) : null}
          <span className="font-mono text-xs">· {committee.thomas_id}</span>
          {committee.url ? (
            <a
              href={committee.url}
              target="_blank"
              rel="noreferrer"
              className="underline-offset-2 hover:text-primary hover:underline"
            >
              · committee site
            </a>
          ) : null}
        </p>
        {committee.jurisdiction ? (
          <p className="mt-3 max-w-3xl text-sm text-muted-foreground">
            {committee.jurisdiction}
            {committee.jurisdiction_source ? (
              <>
                {" "}
                <a
                  href={committee.jurisdiction_source}
                  target="_blank"
                  rel="noreferrer"
                  className="underline-offset-2 hover:text-primary hover:underline"
                >
                  source
                </a>
              </>
            ) : null}
          </p>
        ) : null}
      </div>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile
          label="Members"
          value={String(members.length)}
          hint={`${majority} majority · ${minority} minority`}
        />
        <StatTile label="With disclosed trades" value={String(traders)} hint="any counted trade" />
        <StatTile
          label="Volume (est.)"
          value={usd(volume)}
          hint={
            transcribed
              ? `bracket midpoints · ${transcribed} transcribed row${transcribed === 1 ? "" : "s"} not counted`
              : "bracket midpoints, all members"
          }
        />
        <StatTile label="Late disclosures" value={String(late)} hint="past 45 days" />
      </section>

      {subs.length ? (
        <section>
          <SectionTitle>Subcommittees</SectionTitle>
          <Card className="p-0">
            <ul className="divide-y divide-border/50 text-[13px]">
              {subs.map((s) => (
                <li key={s.thomas_id} className="flex items-center justify-between gap-3 px-4 py-2">
                  <a href={committeeHref(s.thomas_id)} className="font-medium hover:text-primary">
                    {s.name}
                  </a>
                  <span className="tabular text-[11px] text-muted-foreground">
                    {s.members} member{s.members === 1 ? "" : "s"}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        </section>
      ) : null}

      <section>
        <SectionTitle
          right={
            <span className="text-[11px] text-muted-foreground">
              delay = mean days from trade to filing
            </span>
          }
        >
          Members
        </SectionTitle>
        {members.length ? (
          <ResponsiveTable>
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-border text-left text-[11px] uppercase tracking-[0.06em] text-muted-foreground">
                  <th className="px-4 py-2.5 font-medium">Member</th>
                  <th className="px-4 py-2.5 font-medium">Seat</th>
                  <th className="px-4 py-2.5 text-right font-medium">Trades</th>
                  <th className="px-4 py-2.5 text-right font-medium">Tickers</th>
                  <th className="px-4 py-2.5 text-right font-medium">Buy / Sell</th>
                  <th className="px-4 py-2.5 text-right font-medium">Volume (est.)</th>
                  <th className="px-4 py-2.5 text-right font-medium">Delay</th>
                  <th className="px-4 py-2.5 text-right font-medium">Late</th>
                </tr>
              </thead>
              <tbody>
                {members.map((r) => (
                  <tr
                    key={r.bioguide_id ?? r.member_name}
                    className="border-b border-border/50 last:border-0 hover:bg-muted/50"
                  >
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-2">
                        <MemberAvatar name={r.member_name} bioguideId={r.bioguide_id} size="sm" />
                        {r.trades > 0 ? (
                          <a href={memberHref(r.member_name, r.bioguide_id)} className="font-medium hover:text-primary">
                            {r.member_name}
                          </a>
                        ) : (
                          <span className="font-medium">{r.member_name}</span>
                        )}
                        <PartyBadge party={r.party} />
                        <span className="text-[11px] text-muted-foreground">
                          {r.state}
                          {r.district && r.district !== "0" ? r.district : ""}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-2">
                      <SeatTag seat={r} />
                    </td>
                    <td className="tabular px-4 py-2 text-right">{r.trades || "—"}</td>
                    <td className="tabular px-4 py-2 text-right text-muted-foreground">
                      {r.tickers || "—"}
                    </td>
                    <td className="tabular px-4 py-2 text-right text-muted-foreground">
                      {r.trades ? `${r.buys} / ${r.sells}` : "—"}
                    </td>
                    <td className="tabular px-4 py-2 text-right">{r.trades ? usd(r.volume_mid) : "—"}</td>
                    <td className="tabular px-4 py-2 text-right text-muted-foreground">
                      {r.avg_delay == null ? "—" : `${Math.round(r.avg_delay)}d`}
                    </td>
                    <td
                      className={`tabular px-4 py-2 text-right ${
                        r.late_count > 0
                          ? "font-medium text-red-600 dark:text-red-400"
                          : "text-muted-foreground"
                      }`}
                    >
                      {r.late_count || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ResponsiveTable>
        ) : (
          <Empty>No seats recorded for this committee.</Empty>
        )}
        <p className="mt-3 text-[11px] text-muted-foreground">
          Seats are the current Congress&rsquo;s roster from congress-legislators, refreshed
          with the pipeline. Each member&rsquo;s figures cover every trade they disclosed, not
          only trades touching this committee&rsquo;s jurisdiction; a member with no disclosed
          trades is listed with dashes. &ldquo;Late&rdquo; counts trades filed more than 45
          days after the trade — a reporting fact, not an allegation of wrongdoing.
        </p>
      </section>
    </div>
  );
}

/* ---------------------------------------------------------- ?view=late */

/** Filings listed on the late view, newest first; the tiles cover all. */
const LATE_FILING_PAGE = 25;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function monthLabel(month: string, withYear: boolean): string {
  const [y, m] = month.split("-");
  const name = MONTHS[Number(m) - 1] ?? month;
  return withYear || m === "01" ? `${name} ${y.slice(2)}` : name;
}

/** "12%" — one decimal under 10% so a small share does not read as zero. */
function share(n: number, of: number): string {
  if (!of) return "—";
  const pct = (n / of) * 100;
  return `${pct > 0 && pct < 10 ? pct.toFixed(1) : Math.round(pct)}%`;
}

/**
 * The ranked late-filing view. Every number here is the same measure the
 * politicians tiles report — trade date → filing date, more than 45 days —
 * and the tiles come from the same whole-dataset totals, so the two pages
 * cannot disagree.
 */
async function LateView() {
  let totals, late, members, monthly, filings;
  try {
    [totals, late, members, monthly, filings] = await Promise.all([
      getPoliticianTotals(),
      getLateTotals(),
      getLateMembers(200),
      getLateMonthly(),
      getLateFilings(LATE_FILING_PAGE),
    ]);
  } catch (err) {
    return <Empty>{(err as Error).message}</Empty>;
  }
  if (!members.length) {
    return (
      <Empty>
        No trades disclosed past the {STOCK_ACT_DEADLINE_DAYS}-day deadline.{" "}
        <a href="/politicians" className="underline underline-offset-2 hover:text-primary">
          All members
        </a>
      </Empty>
    );
  }

  const byWorst = [...members].sort(
    (a, b) => b.worst_delay - a.worst_delay || b.late_count - a.late_count
  );

  return (
    <div className="space-y-8">
      <div>
        <a href="/politicians" className="text-xs text-muted-foreground hover:text-primary">
          ← all members
        </a>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">Late disclosures</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Trades disclosed more than {STOCK_ACT_DEADLINE_DAYS} days after they were made — the
          STOCK Act&rsquo;s deadline. Delay is measured from the trade to the date the report
          reached the Clerk, never the report&rsquo;s &ldquo;Notification Date&rdquo; column,
          which reads 0 for a member trading their own account. A late count is a reporting
          fact, not an allegation of wrongdoing.
        </p>
      </div>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile
          label="Late trades"
          value={String(totals.late_trades)}
          hint={`${share(totals.late_trades, late.trades)} of ${late.trades} disclosed trades`}
        />
        <StatTile
          label="Members late"
          value={String(totals.members_late)}
          hint={`of ${totals.members} with disclosed trades`}
        />
        <StatTile
          label="Filings with late trades"
          value={String(late.late_filings)}
          hint={`${late.all_late_filings} entirely late · of ${late.filings} filings`}
        />
        <StatTile
          label="Worst delay"
          value={late.worst_delay == null ? "—" : `${late.worst_delay}d`}
          hint="trade to filing"
        />
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        <div>
          <SectionTitle>By late trades</SectionTitle>
          <Card>
            <MemberBars
              data={members.slice(0, 12).map((r) => ({
                key: r.member_name,
                name: r.member_name,
                bioguideId: r.bioguide_id,
                sublabel: `${r.late_count} of ${r.trades} trades · ${r.late_filings} filing${
                  r.late_filings === 1 ? "" : "s"
                }`,
                value: r.late_count,
                valueLabel: String(r.late_count),
                href: memberHref(r.member_name, r.bioguide_id),
              }))}
            />
          </Card>
        </div>
        <div>
          <SectionTitle>By worst delay</SectionTitle>
          <Card>
            <MemberBars
              data={byWorst.slice(0, 12).map((r) => ({
                key: r.member_name,
                name: r.member_name,
                bioguideId: r.bioguide_id,
                sublabel: `${r.late_count} late · mean ${Math.round(r.avg_late_delay)}d`,
                value: r.worst_delay,
                valueLabel: `${r.worst_delay}d`,
                href: memberHref(r.member_name, r.bioguide_id),
              }))}
            />
          </Card>
        </div>
      </section>

      <section>
        <SectionTitle
          right={
            <span className="text-[11px] text-muted-foreground">
              share of each month&rsquo;s filed trades that were late
            </span>
          }
        >
          Late share by month filed
        </SectionTitle>
        <Card>
          <ColumnSeries
            data={monthly.map((m, i) => ({
              key: m.month,
              label: monthLabel(m.month, i === 0),
              value: m.trades ? m.late_trades / m.trades : 0,
              valueLabel: share(m.late_trades, m.trades),
              detail: `${m.late_trades} of ${m.trades} trades in ${m.filings} filings`,
            }))}
          />
        </Card>
        <ResponsiveTable className="mt-4">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b border-border text-left text-[11px] uppercase tracking-[0.06em] text-muted-foreground">
                <th className="py-1.5 pr-3 font-medium">Month filed</th>
                <th className="py-1.5 pr-3 text-right font-medium">Filings</th>
                <th className="py-1.5 pr-3 text-right font-medium">Trades</th>
                <th className="py-1.5 pr-3 text-right font-medium">Late</th>
                <th className="py-1.5 pr-3 text-right font-medium">Share</th>
                <th className="py-1.5 text-right font-medium">Members late</th>
              </tr>
            </thead>
            <tbody>
              {monthly.map((m) => (
                <tr key={m.month} className="border-b border-border/50 last:border-0">
                  <td className="tabular py-1.5 pr-3">{m.month}</td>
                  <td className="tabular py-1.5 pr-3 text-right text-muted-foreground">{m.filings}</td>
                  <td className="tabular py-1.5 pr-3 text-right text-muted-foreground">{m.trades}</td>
                  <td
                    className={`tabular py-1.5 pr-3 text-right ${
                      m.late_trades > 0 ? "font-medium text-red-600 dark:text-red-400" : "text-muted-foreground"
                    }`}
                  >
                    {m.late_trades || "—"}
                  </td>
                  <td className="tabular py-1.5 pr-3 text-right">{share(m.late_trades, m.trades)}</td>
                  <td className="tabular py-1.5 text-right text-muted-foreground">
                    {m.members_late || "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ResponsiveTable>
        <p className="mt-3 text-[11px] text-muted-foreground">
          By month of filing, not of trade: a trade made last month cannot be late yet, and
          the ones that will be are not in the database until they are filed. A month&rsquo;s
          filings are complete once the month is over.
        </p>
      </section>

      <section>
        <SectionTitle
          right={
            <span className="text-[11px] text-muted-foreground">
              ranked by late trades, then worst delay
            </span>
          }
        >
          All members with late trades
        </SectionTitle>
        <ResponsiveTable>
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-border text-left text-[11px] uppercase tracking-[0.06em] text-muted-foreground">
                <th className="px-4 py-2.5 font-medium">Member</th>
                <th className="px-4 py-2.5 text-right font-medium">Trades</th>
                <th className="px-4 py-2.5 text-right font-medium">Late</th>
                <th className="px-4 py-2.5 text-right font-medium">Share</th>
                <th className="px-4 py-2.5 text-right font-medium">Worst delay</th>
                <th className="px-4 py-2.5 text-right font-medium">Mean late delay</th>
                <th className="px-4 py-2.5 text-right font-medium">Filings</th>
                <th className="px-4 py-2.5 text-right font-medium">Last late filing</th>
              </tr>
            </thead>
            <tbody>
              {members.map((r) => (
                <tr key={r.member_name} className="border-b border-border/50 last:border-0 hover:bg-muted/50">
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-2">
                      <MemberAvatar name={r.member_name} bioguideId={r.bioguide_id} size="sm" />
                      <a href={memberHref(r.member_name, r.bioguide_id)} className="font-medium hover:text-primary">
                        {r.member_name}
                      </a>
                      <PartyBadge party={r.party} />
                      <span className="text-[11px] text-muted-foreground">
                        {r.state}
                        {r.district && r.district !== "0" ? r.district : ""}
                      </span>
                    </div>
                  </td>
                  <td className="tabular px-4 py-2 text-right text-muted-foreground">{r.trades}</td>
                  <td className="tabular px-4 py-2 text-right font-medium text-red-600 dark:text-red-400">
                    {r.late_count}
                  </td>
                  <td className="tabular px-4 py-2 text-right">{share(r.late_count, r.trades)}</td>
                  <td className="tabular px-4 py-2 text-right">{r.worst_delay}d</td>
                  <td className="tabular px-4 py-2 text-right text-muted-foreground">
                    {Math.round(r.avg_late_delay)}d
                  </td>
                  <td className="tabular px-4 py-2 text-right text-muted-foreground">{r.late_filings}</td>
                  <td className="tabular px-4 py-2 text-right text-muted-foreground">
                    {shortDate(r.last_late_filing)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ResponsiveTable>
        <p className="mt-3 text-[11px] text-muted-foreground">
          &ldquo;Worst delay&rdquo; is the longest gap from a trade to its filing;
          &ldquo;Mean late delay&rdquo; averages the late trades only. A trade whose dates
          contradict each other has no delay and is never counted as late.
        </p>
      </section>

      <section>
        <SectionTitle
          right={
            <span className="text-[11px] text-muted-foreground">
              {filings.length < late.late_filings
                ? `newest ${filings.length} of ${late.late_filings} filings`
                : `${filings.length} filing${filings.length === 1 ? "" : "s"}`}
            </span>
          }
        >
          The filings behind the numbers
        </SectionTitle>
        <div className="space-y-3">
          {filings.map((f) => (
            <Card key={f.filing_id} className="px-4 py-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
                <PartyBadge party={f.party} />
                <a href={memberHref(f.member_name, f.bioguide_id)} className="font-medium hover:text-primary">
                  {f.member_name}
                </a>
                <span className="text-[11px] text-muted-foreground">
                  {f.state}
                  {f.district && f.district !== "0" ? f.district : ""}
                </span>
                <span className="text-xs text-muted-foreground">filed {shortDate(f.filing_date)}</span>
                <span
                  className="text-xs font-medium text-red-600 dark:text-red-400"
                  title={
                    f.late.length === f.trades
                      ? "Every trade in this filing was past the deadline — its Telegram message led with how late"
                      : "Some trades in this filing were on time; the late ones are listed"
                  }
                >
                  {f.late.length === f.trades
                    ? `all ${f.trades} trade${f.trades === 1 ? "" : "s"} late`
                    : `${f.late.length} of ${f.trades} trades late`}
                </span>
                <a
                  href={f.pdf_url}
                  target="_blank"
                  rel="noreferrer"
                  className="ml-auto text-[11px] text-muted-foreground underline-offset-2 hover:text-primary hover:underline"
                >
                  filing
                </a>
              </div>
              <div className="mt-2 space-y-1">
                {f.late.map((r) => (
                  <div
                    key={r.id}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/50 pt-1 first:border-0 first:pt-0"
                  >
                    <ActionBadge action={r.action} />
                    <TickerChip ticker={r.ticker} type={r.asset_type} />
                    <Amount
                      min={r.amount_min_cents}
                      max={r.amount_max_cents}
                      exact={r.amount_exact_cents}
                    />
                    <OwnerTag owner={r.owner} />
                    <ScanTag transcribed={r.transcribed} docId={r.doc_id} />
                    <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">
                      {r.asset_name}
                    </span>
                    <span className="tabular text-xs text-muted-foreground">
                      traded {shortDate(r.tx_date)}
                    </span>
                    <DelayTag days={r.delay_days} inconsistent={r.dates_inconsistent} />
                  </div>
                ))}
              </div>
            </Card>
          ))}
        </div>
      </section>
    </div>
  );
}
