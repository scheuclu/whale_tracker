import { Search } from "lucide-react";
import { memberHref, shortDate, tickerHref } from "@/lib/format";
import { searchInsiderIssuers } from "@/lib/insider-queries";
import { searchMembers, searchRoster, searchTickers } from "@/lib/queries";
import { Card, Empty, SectionTitle } from "../charts";
import { PAGE_STACK, PageHeader, Quiet } from "../page-header";
import { BUTTON_PRIMARY, FIELD, PartyBadge } from "../ui";
import { cn } from "@/lib/utils";
import { MemberAvatar } from "../avatar";
import { pageMetadata } from "@/lib/seo";

export const dynamic = "force-dynamic";

// Result pages are `noindex, follow`: an endless space of near-duplicate
// URLs that only point at the member and ticker pages, which the sitemap
// lists directly. The links are still followed.
export const metadata = pageMetadata({
  title: "Search members, tickers and insider issuers",
  description: "Find a member of Congress, a ticker or a corporate insider issuer.",
  path: "/search",
  noindex: true,
});

/** Hits per list; the lists say when there may be more. */
const LIMIT = 20;
const QUERY_MAX = 80;

/**
 * One box for the three things a reader comes looking for: a member, a
 * ticker, an insider issuer. Server-rendered from the query string, so a
 * result page is a URL. The congressional and insider lists come from
 * separate queries and are never pooled — different tables, different
 * meanings of "trade".
 */
export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[] }>;
}) {
  const params = await searchParams;
  const raw = Array.isArray(params.q) ? params.q[0] : params.q;
  const q = (raw ?? "").trim().slice(0, QUERY_MAX);

  return (
    <div className={PAGE_STACK}>
      <PageHeader title="Search" subtitle="Members of Congress, the tickers they trade, and SEC Form 4 insider issuers.">
        <form method="get" action="/search" role="search" className="flex max-w-xl items-center gap-2">
          <label className="relative min-w-0 flex-1">
            <span className="sr-only">Search members, tickers and insider issuers</span>
            <Search
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <input
              type="search"
              name="q"
              defaultValue={q}
              maxLength={QUERY_MAX}
              placeholder="Search members, tickers, issuers"
              autoFocus={!q}
              className={cn(FIELD, "h-10 pl-9 pr-3 text-sm")}
            />
          </label>
          <button type="submit" className={cn(BUTTON_PRIMARY, "h-10 shrink-0 px-4 text-sm")}>
            Search
          </button>
        </form>
      </PageHeader>

      {q ? <Results q={q} /> : <Quiet>Type a member&rsquo;s name, a ticker symbol or a company.</Quiet>}
    </div>
  );
}

const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;

async function Results({ q }: { q: string }) {
  let members, roster, tickers, issuers;
  try {
    [members, roster, tickers, issuers] = await Promise.all([
      searchMembers(q, LIMIT),
      searchRoster(q, 10),
      searchTickers(q, LIMIT),
      searchInsiderIssuers(q, LIMIT),
    ]);
  } catch (err) {
    return <Empty>{(err as Error).message}</Empty>;
  }

  const none = !members.length && !roster.length && !tickers.length && !issuers.length;
  const seat = (r: { state: string | null; district: string | null; chamber: string | null }) =>
    [
      r.chamber === "senate" ? "Senate" : r.chamber === "house" ? "House" : null,
      r.state ? `${r.state}${r.district && r.district !== "0" ? `-${r.district}` : ""}` : null,
    ]
      .filter(Boolean)
      .join(" · ");

  // Each group is its own query and is never pooled with another. Groups
  // with hits come first in a fixed order; the empty ones fold into one
  // quiet line at the end instead of three dashed boxes.
  const groups = [
    {
      key: "members",
      hits: members.length + roster.length,
      noun: "members",
      node: (
        <section key="members" aria-labelledby="search-members">
          <SectionTitle
            right={
              more(members.length) ?? (
                <span className="text-[12px] text-muted-foreground">
                  {plural(members.length, "member")} with trades
                  {roster.length ? ` · ${roster.length} in the roster only` : ""}
                </span>
              )
            }
          >
            <span id="search-members">Members</span>
          </SectionTitle>
          <Card className="divide-y divide-border/50 p-0 sm:p-0">
            {members.map((m) => (
              <a
                key={m.member_name}
                href={memberHref(m.member_name, m.bioguide_id)}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-[13px] transition-colors duration-150 hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none"
              >
                <MemberAvatar name={m.member_name} bioguideId={m.bioguide_id} size="md" />
                <span className="font-medium">{m.member_name}</span>
                <PartyBadge party={m.party} />
                <span className="text-muted-foreground">{seat(m) || "not matched to the roster"}</span>
                <span className="ml-auto tabular text-xs text-muted-foreground">
                  {plural(m.trades, "trade")} ·{" "}
                  {m.tickers ? plural(m.tickers, "ticker") : "no ticker printed"} · last {shortDate(m.last_tx_date)}
                </span>
              </a>
            ))}
            {roster.map((r) => (
              <div
                key={`roster-${r.full_name}`}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-[13px] text-muted-foreground"
              >
                <MemberAvatar name={r.full_name} bioguideId={r.bioguide_id} size="md" className="opacity-80" />
                <span>{r.full_name}</span>
                <PartyBadge party={r.party} />
                <span>{seat(r)}</span>
                <span className="ml-auto text-xs">in the roster · no disclosed trades in this database</span>
              </div>
            ))}
          </Card>
        </section>
      ),
    },
    {
      key: "tickers",
      hits: tickers.length,
      noun: "congressional tickers",
      node: (
        <section key="tickers" aria-labelledby="search-tickers">
          <SectionTitle
            right={
              more(tickers.length) ?? (
                <span className="text-[12px] text-muted-foreground">House &amp; Senate disclosures</span>
              )
            }
          >
            <span id="search-tickers">Tickers</span>
          </SectionTitle>
          <Card className="divide-y divide-border/50 p-0 sm:p-0">
            {tickers.map((t) => (
              <a
                key={t.ticker}
                href={tickerHref(t.ticker)}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-[13px] transition-colors duration-150 hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none"
              >
                <span className="font-mono font-semibold">{t.ticker}</span>
                <span className="min-w-0 truncate text-muted-foreground">{t.asset_name}</span>
                <span className="ml-auto tabular text-xs text-muted-foreground">
                  {plural(t.politicians, "member")} · {plural(t.trades, "trade")} · last {shortDate(t.last_tx_date)}
                </span>
              </a>
            ))}
          </Card>
        </section>
      ),
    },
    {
      key: "issuers",
      hits: issuers.length,
      noun: "insider issuers",
      node: (
        <section key="issuers" aria-labelledby="search-issuers">
          <SectionTitle
            right={
              more(issuers.length) ?? <span className="text-[12px] text-muted-foreground">SEC Form 4, kept apart</span>
            }
          >
            <span id="search-issuers">Insider issuers</span>
          </SectionTitle>
          <Card className="divide-y divide-border/50 p-0 sm:p-0">
            {issuers.map((i) => {
              const inner = (
                <>
                  <span className="font-mono font-semibold">{i.ticker ?? "—"}</span>
                  <span className="min-w-0 truncate text-muted-foreground">{i.issuer_name}</span>
                  <span className="ml-auto tabular text-xs text-muted-foreground">
                    {plural(i.insiders, "insider")} · {plural(i.filings, "filing")} · {plural(i.trades, "trade")} · last{" "}
                    {shortDate(i.last_tx_date)}
                  </span>
                </>
              );
              const cls = "flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-[13px]";
              return i.ticker ? (
                <a
                  key={i.issuer_cik}
                  href={`/insiders?t=${encodeURIComponent(i.ticker)}`}
                  className={`${cls} transition-colors duration-150 hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none`}
                >
                  {inner}
                </a>
              ) : (
                <div key={i.issuer_cik} className={cls}>
                  {inner}
                </div>
              );
            })}
          </Card>
        </section>
      ),
    },
  ];
  const found = groups.filter((g) => g.hits > 0);
  const empty = groups.filter((g) => g.hits === 0);

  return (
    <>
      <p className="text-[13px] text-muted-foreground" data-testid="search-summary">
        {none
          ? `No members, tickers or insider issuers match “${q}”.`
          : `Results for “${q}”: ${members.length} member${members.length === 1 ? "" : "s"}, ` +
            `${tickers.length} ticker${tickers.length === 1 ? "" : "s"}, ` +
            `${issuers.length} insider issuer${issuers.length === 1 ? "" : "s"}`}
      </p>
      {found.map((g) => g.node)}
      {empty.length && !none ? (
        <Quiet>
          No match among {empty.map((g) => g.noun).join(empty.length === 2 ? " or " : ", ").replace(/, ([^,]*)$/, ", or $1")}.
        </Quiet>
      ) : null}
    </>
  );
}

function more(n: number) {
  return n >= LIMIT ? (
    <span className="text-[12px] text-muted-foreground">first {LIMIT} — narrow the search for more</span>
  ) : null;
}
