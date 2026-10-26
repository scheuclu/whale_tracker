import { Fragment } from "react";
import {
  getCommittee,
  getCommitteeMembers,
  getPoliticianTotals,
  getPoliticians,
  getSubcommittees,
} from "@/lib/queries";
import type { Metadata } from "next";
import { committeeHref, memberHref, usd } from "@/lib/format";
import { absoluteUrl, plural } from "@/lib/site";
import { ShareControl } from "../share-control";
import { clip, pageCard, pageMetadata } from "@/lib/seo";
import {
  Card,
  Empty,
  SectionTitle,
  StatTile,
} from "../charts";
import {
  PartyBadge,
  ResponsiveTable,
} from "../ui";
import { MemberAvatar } from "../avatar";
import { Disclosure } from "../disclosure";
import { DataError, PAGE_STACK, PageHeader, Quiet } from "../page-header";
import { CHAMBER_LABEL, SeatTag } from "../members/[slug]/member-detail";
import { POLITICIAN_SORT, isDefaultSort, parseSort, type PoliticianSortKey } from "@/lib/table-sort";
import {
  BODY_ROW,
  BarCell,
  DATA_TABLE,
  HEAD_ROW,
  LateCell,
  SortHeader,
  SplitCell,
  sortHref,
} from "../sortable-table";
import { RowLinkBody, StickyThead } from "../table-client";
import { ROW_LINK } from "../grouped-list";
import { LATE_PATH } from "../rankings/late-view";
import { PeopleSwitch } from "../people-switch";

export const dynamic = "force-dynamic";

type Params = { action?: string; committee?: string; view?: string; sort?: string; dir?: string; h?: string };

/**
 * Two pages share this route: the roster and `?committee=<id>`. Each
 * canonicalises to itself with only the parameter that defines it; a sorted
 * roster is the roster, so its canonical is the bare path. The track record
 * and late view moved to /rankings.
 */
export async function generateMetadata({ searchParams }: { searchParams: Promise<Params> }): Promise<Metadata> {
  const params = await searchParams;
  if (params.committee) {
    const path = `/politicians?committee=${encodeURIComponent(params.committee)}`;
    let name: string | null = null;
    let id = params.committee;
    let seats = 0;
    let traders = 0;
    try {
      const [committee, members] = await Promise.all([getCommittee(params.committee), getCommitteeMembers(params.committee)]);
      name = committee?.name ?? null;
      id = committee?.thomas_id ?? id;
      seats = members.length;
      traders = members.filter((m) => m.trades > 0).length;
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
      card: pageCard(
        `/cards/committee/${encodeURIComponent(id)}`,
        `${name}: ${plural(seats, "seat")}, ${plural(traders, "member")} with disclosed trades, and their buy and sell counts`
      ),
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
    card: pageCard("/politicians", "Members of Congress trading stocks: members, disclosed trades, tickers and members who filed late"),
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
  // Keyed so a switch between list and sub-view (a search-param change)
  // remounts instead of morphing the list DOM.
  // `?view=track` and `?view=late` are answered with a 308 to /rankings
  // before they get here (next.config.ts).
  if (params.committee)
    return (
      <Fragment key={`c:${params.committee}`}>
        <CommitteeView id={params.committee} />
      </Fragment>
    );

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
    return <DataError error={err} />;
  }
  if (!rows.length) return <Empty>No transactions yet.</Empty>;
  table ??= rows;

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
    <div className={PAGE_STACK}>
      <PageHeader
        lead={<PeopleSwitch active="congress" />}
        eyebrow="Congress · by member"
        title="Members of Congress"
        subtitle="Every member with a disclosed trade, sortable by trades, tickers, estimated volume and filing delay. Amounts are disclosed brackets, so every volume here is an estimate."
      >
      <section aria-label="All members" className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <StatTile label="Members" value={String(totals.members)} hint="with disclosed trades" />
        <StatTile label="Total volume" value={usd(totals.volume_mid)} hint="estimated" />
        <a href={LATE_PATH} className="block rounded-tile [&>div]:transition-shadow [&>div]:duration-(--dur) hover:[&>div]:shadow-[var(--elev-card-hover)]" title="Ranked late-filing view">
          <StatTile
            label="Late disclosures"
            value={totals.late_trades.toLocaleString()}
            hint="past 45 days · ranked view →"
          />
        </a>
        <a href={LATE_PATH} className="block rounded-tile [&>div]:transition-shadow [&>div]:duration-(--dur) hover:[&>div]:shadow-[var(--elev-card-hover)]" title="Ranked late-filing view">
          <StatTile
            label="Members late"
            value={String(totals.members_late)}
            hint="at least once · ranked view →"
          />
        </a>
      </section>
      <a
        href="/rankings"
        className="apple-hero-surface apple-card-reveal group flex items-center justify-between gap-4 rounded-tile px-5 py-4 transition-all duration-300 hover:-translate-y-0.5 hover:shadow-elevated sm:px-6 sm:py-5"
        data-rankings-link
      >
        <span className="min-w-0">
          <span className="apple-section-kicker mb-1">Rankings</span>
          <span className="block font-display text-[18px] font-bold tracking-[-0.02em] text-foreground sm:text-[20px]">
            Track record, most active, late filers
          </span>
          <span className="mt-0.5 block text-[13.5px] leading-snug text-muted-foreground">
            Whose trades were followed by the biggest market-beating moves, who trades the most, and who files late.
          </span>
        </span>
        <span aria-hidden className="inline-flex shrink-0 items-center gap-1 rounded-full bg-fill/85 px-3.5 py-1.5 text-[13px] font-semibold text-foreground ring-1 ring-black/[0.05] transition-transform duration-200 group-hover:translate-x-0.5 dark:ring-white/[0.08]">
          Explore <span className="text-[16px] leading-none">›</span>
        </span>
      </a>
      </PageHeader>

      <section id="all-members" className="table-anchor">
        <SectionTitle
          kicker="Complete Roster"
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
                {header("buysell", "Buy / sell", { hint: BUYSELL_HINT })}
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
                      <a
                        href={memberHref(r.member_name, r.bioguide_id)}
                        className="row-name block max-w-[9.5rem] truncate font-medium sm:max-w-none"
                        title={r.member_name}
                      >
                        {r.member_name}
                      </a>
                      <PartyBadge party={r.party} />
                      {/* The seat is in the member's page; a phone gives its width to the figures. */}
                      <span className="hidden text-[12px] text-muted-foreground sm:inline">
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
        <Disclosure
          size="sm"
          className="mt-3"
          lead={
            <>
              &ldquo;Delay&rdquo; is measured from the trade to the date the report reached the Clerk, and
              &ldquo;Late&rdquo; counts trades filed more than 45 days after the trade — the STOCK Act&rsquo;s
              deadline.
            </>
          }
        >
          <p>A late count is a reporting fact, not an allegation of wrongdoing.</p>
          <p>
            &ldquo;Notify lag&rdquo; is a different measure: how long until the member learned of the trade. A
            nonzero lag means someone else placed it — a spouse, a trust or a managed account — and carries no
            compliance meaning.
          </p>
        </Disclosure>
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
    return <DataError error={err} />;
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
    <div className={PAGE_STACK}>
      <PageHeader
        back={{ href: "/politicians", label: "all members" }}
        share={<ShareControl url={absoluteUrl(committeeHref(committee.thomas_id))} text={`${committee.name}: members' disclosed stock trades`} />}
        eyebrow="Committee"
        title={committee.name}
        subtitle={
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
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
        </span>
        }
      >
        {committee.jurisdiction ? (
          <p className="max-w-[68ch] text-[14px] leading-relaxed text-muted-foreground">
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
      <section aria-label="Committee totals" className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
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
      </PageHeader>

      {subs.length ? (
        <section>
          <SectionTitle>Subcommittees</SectionTitle>
          <Card className="p-0 sm:p-0">
            <ul className="inset-rows py-1 text-[14px] [--sep-inset:1rem] sm:[--sep-inset:1.25rem]">
              {subs.map((s) => (
                <li key={s.thomas_id} className="flex min-h-11 items-center justify-between gap-3 px-4 py-2.5 sm:px-5">
                  <a href={committeeHref(s.thomas_id)} className={ROW_LINK}>
                    {s.name}
                  </a>
                  <span className="tabular text-[13px] text-muted-foreground">
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
                <tr className="border-b border-border text-left text-[12px] font-medium text-muted-foreground">
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
                    className="border-b border-border/60 transition-colors duration-(--dur-fast) last:border-0 hover:bg-raised"
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
                          ? "font-medium text-foreground"
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
          <Quiet>No seats recorded for this committee.</Quiet>
        )}
        <Disclosure
          size="sm"
          className="mt-3"
          lead={
            <>
              Each member&rsquo;s figures cover every trade they disclosed, not only trades touching this
              committee&rsquo;s jurisdiction.
            </>
          }
        >
          <p>
            Seats are the current Congress&rsquo;s roster from congress-legislators, refreshed with the
            pipeline. A member with no disclosed trades is listed with dashes.
          </p>
          <p>
            &ldquo;Late&rdquo; counts trades filed more than 45 days after the trade — a reporting fact, not an
            allegation of wrongdoing.
          </p>
        </Disclosure>
      </section>
    </div>
  );
}

