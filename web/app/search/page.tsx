import { Search } from "lucide-react";
import { memberHref, shortDate } from "@/lib/format";
import { searchInsiderIssuers } from "@/lib/insider-queries";
import { searchMembers, searchRoster, searchTickers } from "@/lib/queries";
import { Card, Empty, SectionTitle } from "../charts";
import { BUTTON_PRIMARY, FIELD, PartyBadge } from "../ui";
import { cn } from "@/lib/utils";
import { MemberAvatar } from "../avatar";

export const dynamic = "force-dynamic";

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
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Search</h1>
        <form method="get" action="/search" role="search" className="mt-3 flex max-w-xl items-center gap-2">
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
          <button type="submit" className={cn(BUTTON_PRIMARY, "h-10 px-4 text-sm")}>
            Search
          </button>
        </form>
      </div>

      {q ? <Results q={q} /> : <Empty>Type a member&rsquo;s name, a ticker symbol or a company.</Empty>}
    </div>
  );
}

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

  return (
    <>
      <p className="text-xs text-muted-foreground" data-testid="search-summary">
        {none
          ? `No members, tickers or insider issuers match “${q}”.`
          : `Results for “${q}”: ${members.length} member${members.length === 1 ? "" : "s"}, ` +
            `${tickers.length} ticker${tickers.length === 1 ? "" : "s"}, ` +
            `${issuers.length} insider issuer${issuers.length === 1 ? "" : "s"}`}
      </p>

      <section>
        <SectionTitle right={more(members.length)}>Members</SectionTitle>
        {members.length || roster.length ? (
          <Card className="divide-y divide-border/50 p-0">
            {members.map((m) => (
              <a
                key={m.member_name}
                href={memberHref(m.member_name)}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-[13px] hover:bg-muted/50"
              >
                <MemberAvatar name={m.member_name} bioguideId={m.bioguide_id} size="md" />
                <span className="font-medium">{m.member_name}</span>
                <PartyBadge party={m.party} />
                <span className="text-muted-foreground">{seat(m) || "not matched to the roster"}</span>
                <span className="ml-auto tabular text-xs text-muted-foreground">
                  {m.trades.toLocaleString()} trade{m.trades === 1 ? "" : "s"} · {m.tickers} ticker
                  {m.tickers === 1 ? "" : "s"} · last {shortDate(m.last_tx_date)}
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
        ) : (
          <Empty>No member matches.</Empty>
        )}
      </section>

      <section>
        <SectionTitle right={more(tickers.length)}>Tickers</SectionTitle>
        {tickers.length ? (
          <Card className="divide-y divide-border/50 p-0">
            {tickers.map((t) => (
              <a
                key={t.ticker}
                href={`/tickers?t=${encodeURIComponent(t.ticker)}`}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-[13px] hover:bg-muted/50"
              >
                <span className="font-mono font-semibold">{t.ticker}</span>
                <span className="truncate text-muted-foreground">{t.asset_name}</span>
                <span className="ml-auto tabular text-xs text-muted-foreground">
                  {t.politicians} member{t.politicians === 1 ? "" : "s"} · {t.trades.toLocaleString()} trade
                  {t.trades === 1 ? "" : "s"} · last {shortDate(t.last_tx_date)}
                </span>
              </a>
            ))}
          </Card>
        ) : (
          <Empty>No congressional ticker matches.</Empty>
        )}
      </section>

      <section>
        <SectionTitle right={more(issuers.length)}>Insider issuers</SectionTitle>
        {issuers.length ? (
          <Card className="divide-y divide-border/50 p-0">
            {issuers.map((i) => {
              const inner = (
                <>
                  <span className="font-mono font-semibold">{i.ticker ?? "—"}</span>
                  <span className="truncate text-muted-foreground">{i.issuer_name}</span>
                  <span className="ml-auto tabular text-xs text-muted-foreground">
                    {i.insiders} insider{i.insiders === 1 ? "" : "s"} · {i.filings} filing
                    {i.filings === 1 ? "" : "s"} · {i.trades.toLocaleString()} trade{i.trades === 1 ? "" : "s"} · last{" "}
                    {shortDate(i.last_tx_date)}
                  </span>
                </>
              );
              const cls = "flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-[13px]";
              return i.ticker ? (
                <a key={i.issuer_cik} href={`/insiders?t=${encodeURIComponent(i.ticker)}`} className={`${cls} hover:bg-muted/50`}>
                  {inner}
                </a>
              ) : (
                <div key={i.issuer_cik} className={cls}>
                  {inner}
                </div>
              );
            })}
          </Card>
        ) : (
          <Empty>No insider issuer matches.</Empty>
        )}
      </section>
    </>
  );
}

function more(n: number) {
  return n >= LIMIT ? (
    <span className="text-[11px] text-muted-foreground">first {LIMIT} — narrow the search for more</span>
  ) : null;
}
