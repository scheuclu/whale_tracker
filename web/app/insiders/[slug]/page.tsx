import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { cache } from "react";
import { getInsiderCompanies, getInsiderPerson, type InsiderCompanyRow } from "@/lib/insider-people";
import { getInsiderTrades } from "@/lib/insider-queries";
import { getInsiderTrack, type InsiderTrack } from "@/lib/insider-track-queries";
import { insiderHref, insiderIssuerHref, insiderSlug, shortDate, slugCik, usd } from "@/lib/format";
import { longDate } from "@/lib/members";
import { clip, pageMetadata } from "@/lib/seo";
import { absoluteUrl, plural } from "@/lib/site";
import { points } from "@/lib/track-queries";
import { Card, SectionTitle, StatTile } from "../../charts";
import { MoneyText, RoleTag, TickerChip } from "../../ui";
import { DataError, PAGE_STACK, PageHeader, Quiet } from "../../page-header";
import { GroupedList, ValueRow } from "../../grouped-list";
import { InsiderTradeList } from "../../insider-trade-list";
import { ShareControl } from "../../share-control";
import { DirectionSplit, GlanceTile } from "../../politicians/member-hero";
import { IntervalBar, Points, intervalText, luckText } from "../../track-ui";
import { FollowButton } from "../../watchlist-client";
import { Disclosure } from "../../disclosure";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string }> };

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Slug → CIK → the insider's whole record as a primary reporting owner. */
const load = cache(async (slug: string) => {
  const cik = slugCik(slug);
  if (!cik) return null;
  const person = await getInsiderPerson(cik);
  return person ? { cik, person } : null;
});

/**
 * `/insiders/<name>-<CIK>`. A stale name part moves to the current spelling
 * (as on member pages, a meta refresh: the page streams behind its loading
 * state); an unknown CIK, or one that was never a filing's primary owner, is
 * a 404. The old `/insiders?cik=` filter 308s here (app/api/legacy-redirect).
 */
async function canonicalOrRedirect(props: Props) {
  const slug = decode((await props.params).slug);
  const data = await load(slug);
  if (!data) notFound();
  const canonical = insiderSlug(data.person.name, data.cik);
  if (canonical !== slug) permanentRedirect(`/insiders/${canonical}`);
  return data;
}

function roleLine(p: { is_director: number; is_officer: number; is_ten_percent_owner: number; officer_title: string | null }) {
  return [
    p.is_officer ? p.officer_title ?? "Officer" : null,
    p.is_director ? "Director" : null,
    p.is_ten_percent_owner ? "10% owner" : null,
  ]
    .filter(Boolean)
    .join(", ");
}

export async function generateMetadata(props: Props): Promise<Metadata> {
  const { cik, person } = await canonicalOrRedirect(props);
  const role = roleLine(person);
  const at = person.latest_issuer ? ` at ${person.latest_issuer}` : "";
  return pageMetadata({
    title: `${person.name}: insider trades on SEC Form 4`,
    description: clip(
      `${person.name}${role ? `, ${role}${at}` : at}: ${plural(person.trades, "open-market trade")} in ${plural(person.filings, "Form 4")} ` +
        `(${person.buys} buys, ${person.sells} sells${person.last_tx_date ? `, last on ${person.last_tx_date}` : ""}). Values are shares × reported price.`,
      200
    ),
    path: insiderHref(person.name, cik),
  });
}

export default async function InsiderPage(props: Props) {
  const { cik, person } = await canonicalOrRedirect(props);
  let companies: InsiderCompanyRow[], trades, track: InsiderTrack;
  try {
    [companies, trades, track] = await Promise.all([
      getInsiderCompanies(cik),
      getInsiderTrades({ cik, limit: 200 }),
      getInsiderTrack(cik).catch(() => ({ available: false, scores: [], ranked_count: {}, min_decisions: null, min_filings: null })),
    ]);
  } catch (err) {
    return <DataError error={err} />;
  }
  const role = roleLine(person);
  const value = (v: number, unpriced: number) => (v ? usd(v) : unpriced ? "unpriced" : "—");

  return (
    <div className={PAGE_STACK}>
      <PageHeader
        back={{ href: "/insiders", label: "Insiders" }}
        share={<ShareControl url={absoluteUrl(insiderHref(person.name, cik))} text={`${person.name}: insider trades on SEC Form 4`} />}
        eyebrow="Corporate insider · SEC Form 4"
        title={person.name}
        subtitle={
          <>
            {role || "Reporting owner"}
            {person.latest_issuer ? (
              <>
                {" "}at {person.latest_issuer}
                {person.latest_ticker ? ` (${person.latest_ticker})` : ""}
              </>
            ) : null}
            {person.issuers > 1 ? `, and ${plural(person.issuers - 1, "other company", "other companies")}` : ""}.
          </>
        }
        aside={<FollowButton kind="insider" id={cik} label={person.name} />}
      >
        <section aria-label="Insider totals" className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
          <StatTile label="Filings" value={String(person.filings)} hint={`as primary reporting owner · CIK ${cik}`} />
          <StatTile
            label="Trades"
            value={String(person.trades)}
            hint={person.last_tx_date ? `last ${longDate(person.last_tx_date)}` : undefined}
          />
          <StatTile label="Bought" value={value(person.bought, person.unpriced_buys)} hint="shares × reported price" />
          <StatTile label="Sold" value={value(person.sold, person.unpriced_sells)} hint="shares × reported price" />
        </section>
        <GlanceTile>
          <DirectionSplit buys={person.buys} sells={person.sells} noun="trade" />
        </GlanceTile>
      </PageHeader>

      <TrackSection track={track} />

      <section>
        <SectionTitle kicker="Where they file" right={<span>{plural(companies.length, "company", "companies")}</span>}>
          Companies
        </SectionTitle>
        <GroupedList>
          {companies.map((c) => (
            <ValueRow
              key={c.issuer_cik}
              name={
                c.ticker ? (
                  <span className="inline-flex min-w-0 items-center gap-2">
                    <TickerChip ticker={c.ticker} href={insiderIssuerHref(c.ticker)} />
                    <span className="truncate">{c.issuer_name}</span>
                  </span>
                ) : (
                  <span className="truncate">{c.issuer_name ?? "Unknown issuer"}</span>
                )
              }
              tags={
                <RoleTag
                  isDirector={c.is_director}
                  isOfficer={c.is_officer}
                  isTenPercentOwner={c.is_ten_percent_owner}
                  officerTitle={c.officer_title}
                />
              }
              value={
                <MoneyText
                  value={[c.bought ? `+${usd(c.bought)}` : "", c.sold ? `−${usd(c.sold)}` : ""].filter(Boolean).join(" ") || "—"}
                />
              }
              meta={`${c.buys} buy / ${c.sells} sell · last ${shortDate(c.last_tx_date)}`}
            />
          ))}
        </GroupedList>
      </section>

      <section>
        <SectionTitle kicker="Complete Ledger">Every stored trade</SectionTitle>
        <Disclosure
          size="sm"
          className="mb-3 pl-1"
          lead="Open-market buys and sells from Form 4s of $50k or more in one direction. Values are shares × the price as filed; a filer may report a weighted average."
        >
          <p>A row whose as-filed value is implausible is shown as filed and counted in no total.</p>
        </Disclosure>
        <InsiderTradeList trades={trades} showIssuer />
      </section>
    </div>
  );
}

/** The insider's track record at 90 trading days, or why there is none yet. */
function TrackSection({ track }: { track: InsiderTrack }) {
  if (!track.available) return null;
  const s = track.scores.find((x) => x.horizon === 90);
  const ranked = track.ranked_count[90];
  return (
    <section>
      <SectionTitle
        kicker="Track record · 90 trading days"
        right={
          <a href="/rankings?view=insiders" className="ink-link text-[13px]">
            Insider ranking →
          </a>
        }
      >
        How their stock moved afterwards
      </SectionTitle>
      <Card className="space-y-4">
        {s ? (
          <>
            <div className="grid gap-4 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-center sm:gap-8">
              <div>
                <p className="text-[34px] font-semibold tracking-[-0.02em]">
                  <Points value={s.trade.score} />
                </p>
                <p className="text-[13px] text-muted-foreground">
                  {s.qualifies && s.rank ? `#${s.rank}${ranked ? ` of ${ranked} ranked insiders` : ""}` : "not ranked yet"}
                  {" · "}
                  {plural(s.n, "decision")} over {plural(s.filings, "filing")}
                </p>
              </div>
              {s.qualifies ? (
                <div className="space-y-1">
                  <IntervalBar
                    score={s.trade.score}
                    lo={s.trade.lo}
                    hi={s.trade.hi}
                    scale={Math.max(0.01, Math.abs(s.trade.lo ?? 0), Math.abs(s.trade.hi ?? 0), Math.abs(s.trade.score))}
                    label={`${points(s.trade.score)} points, 90% interval ${intervalText(s.trade.lo, s.trade.hi)}`}
                  />
                  <p className="text-[12.5px] text-muted-foreground">
                    90% interval {intervalText(s.trade.lo, s.trade.hi)} pts · hit rate {Math.round(s.trade.hit_rate * 100)}% ·
                    luck check {luckText(s.trade.luck)} · from the filing {points(s.disclosure.score)} pts
                  </p>
                </div>
              ) : (
                <p className="text-[13.5px] text-muted-foreground">
                  Ranked from {track.min_decisions ?? 8} matured decisions over {track.min_filings ?? 3} filings.
                </p>
              )}
            </div>
            <p className="border-t border-border/70 pt-3 text-[12.5px] leading-relaxed text-muted-foreground">
              How the stocks this insider traded moved over the next 90 trading days against the S&amp;P 500, read the
              way the trade pointed and shrunk toward zero for small samples. A stock&apos;s move, not their profit: an
              insider trades their own company under plans and windows it sets, and none of this is evidence of
              wrongdoing.
            </p>
          </>
        ) : (
          <Quiet>No decision of theirs has reached 90 trading days yet, or none could be priced.</Quiet>
        )}
      </Card>
    </section>
  );
}
