import { memberLabel, range, usd } from "@/lib/format";
import {
  CONGRESS_RULE,
  INSIDER_RULE,
  chartDomain,
  clusterSpans,
  congressEvents,
  insiderEvents,
  type ClusterSpan,
  type LaneTrade,
} from "@/lib/price-overlay";
import { getOverlayInsiderTrades, type OverlayInsiderRow } from "@/lib/price-queries";
import { normaliseSymbol } from "@/lib/prices";
import { sideOf, floorCents } from "@/lib/timeline";
import { getTimelineTrades, type TimelineTrade } from "@/lib/timeline-queries";
import { Card, SectionTitle } from "./charts";
import { Disclosure } from "./disclosure";
import { PriceOverlayChart, type OverlayLane } from "./price-overlay-chart";

/**
 * "Price and trading activity": one symbol's daily closes over the trades of
 * both populations, on the trade-date axis. Mounted on the ticker page and the
 * insider issuer page; fetches its own rows so a fault here leaves the page
 * standing. The closes are fetched by the browser from `/api/prices/<SYMBOL>`
 * (CDN-cached), so a slow price source never delays the page.
 *
 * Descriptive only (CLAUDE.md, "Price overlay"): no return, no excess move, no
 * causal wording. The caption says why a move after a cluster proves nothing.
 */
export async function PriceOverlay({
  ticker,
  focus,
  congress,
  today = new Date().toISOString().slice(0, 10),
}: {
  ticker: string;
  /** Which population the page is about: its lane goes next to the price. */
  focus: "congress" | "insider";
  /** The ticker page already has these; passed in to save a query. */
  congress?: TimelineTrade[];
  today?: string;
}) {
  let members: TimelineTrade[];
  let insiders: OverlayInsiderRow[];
  try {
    [members, insiders] = await Promise.all([
      congress ?? getTimelineTrades({ ticker }),
      getOverlayInsiderTrades(ticker).catch(() => [] as OverlayInsiderRow[]),
    ]);
  } catch {
    return null;
  }

  const domain = chartDomain([...members.map((t) => t.tx_date), ...insiders.map((t) => t.tx_date)], today);
  if (!domain) return null;

  const congressLane: OverlayLane = {
    source: "congress",
    label: "Members of Congress",
    trades: members.map(congressTrade).filter((t): t is LaneTrade => t != null),
  };
  const insiderLane: OverlayLane = {
    source: "insider",
    label: "Corporate insiders (Form 4)",
    trades: insiders.map(insiderTrade).filter((t): t is LaneTrade => t != null),
  };
  const lanes = (focus === "insider" ? [insiderLane, congressLane] : [congressLane, insiderLane]).filter(
    (l) => l.trades.length > 0
  );

  // Insider spans count CIKs (a name can be shared); show them by name.
  const names = new Map(insiders.map((r) => [r.insider_cik ?? "unknown", r.insider_name ?? "Unknown filer"]));
  const spans = [
    ...clusterSpans(congressEvents(members), CONGRESS_RULE, "congress"),
    ...clusterSpans(insiderEvents(insiders), INSIDER_RULE, "insider").map((s) => ({
      ...s,
      people: s.people.map((c) => names.get(c) ?? c).sort(),
    })),
  ].filter((s) => s.end >= domain.lo && s.start <= domain.hi);

  const symbol = ticker.toUpperCase();
  const priceable = normaliseSymbol(symbol) != null;
  const fromYear = Number(domain.lo.slice(0, 4));

  return (
    <section>
      <SectionTitle right={<span className="text-[11px] text-muted-foreground">daily closes · trades by trade date</span>}>
        Price and trading activity
      </SectionTitle>
      <Card>
        <PriceOverlayChart
          symbol={symbol}
          priceable={priceable}
          fromYear={fromYear}
          lo={domain.lo}
          hi={domain.hi}
          lanes={lanes}
          spans={spans}
        />
        <SpanList spans={spans} />
        <Disclosure
          size="sm"
          className="mt-3 px-1"
          lead={
            <>
              Unofficial daily closes (Yahoo), split-adjusted. Trades sit on their <em>trade</em> date: members
              disclose up to 45 days later and insiders within two business days, so the public could not have
              acted on a trade on the day it is drawn. A price move after a shaded cluster is not evidence that
              anyone knew anything — clusters are picked out after the fact, and hindsight makes any pattern look
              meaningful.
            </>
          }
        >
          <p>
            Congressional marks are sized by the bracket floor — the least the disclosed range allows, never the
            amount traded. Insider marks are sized by shares × reported price; a row with no price, or an as-filed
            value too large to be real, gets the smallest mark. The two populations share the time axis only: their
            trades are never counted together.
          </p>
          <p className="mt-2">
            Shaded spans apply each population’s own cluster rule over a window ending on every trade date, as if
            every trade had already been disclosed. Members: at least {CONGRESS_RULE.minPeople} members, each with
            at least {usd(CONGRESS_RULE.minPersonFloorCents)} in bracket floors, and an estimated{" "}
            {usd(CONGRESS_RULE.minVolumeCents)} or more (sum of bracket midpoints) in one direction within{" "}
            {CONGRESS_RULE.windowDays} days, stocks, funds and options only — the cluster alert’s rule. Insiders: at
            least {INSIDER_RULE.minPeople} distinct primary filers in one direction within {INSIDER_RULE.windowDays}{" "}
            days.
          </p>
          <p className="mt-2">
            A trade dated on a weekend or market holiday is drawn on its own date, between the sessions around it;
            its readout gives the closes on either side.
            {domain.outside
              ? ` ${domain.outside} trade${domain.outside === 1 ? " is" : "s are"} dated far before the rest or after today (a filing typo) and ${domain.outside === 1 ? "is" : "are"} not drawn here.`
              : ""}{" "}
            Every trade is also listed below.
          </p>
        </Disclosure>
      </Card>
    </section>
  );
}

function congressTrade(t: TimelineTrade): LaneTrade | null {
  if (!t.tx_date) return null;
  const amount = range(t.amount_min_cents, t.amount_max_cents, t.amount_exact_cents);
  return {
    id: t.id,
    date: t.tx_date,
    side: sideOf(t.action),
    sizeCents: floorCents(t),
    who: memberLabel(t.member_name, t.party, t.state, t.district, t.chamber),
    amount:
      (amount === "—" ? "amount not disclosed" : amount) +
      (t.transcribed ? " · transcribed from a scan, in no total" : ""),
    hollow: Boolean(t.transcribed),
  };
}

function insiderTrade(t: OverlayInsiderRow): LaneTrade | null {
  if (!t.tx_date) return null;
  const side = t.action === "purchase" ? "buy" : t.action === "sale" ? "sell" : "other";
  const role = [t.is_officer ? t.officer_title ?? "Officer" : null, t.is_director ? "Director" : null, t.is_ten_percent_owner ? "10% owner" : null]
    .filter(Boolean)
    .join(", ");
  const priced = t.implausible !== 1 && t.amount_exact_cents != null && t.amount_exact_cents > 0;
  const amount = t.implausible === 1
    ? "as-filed value implausible, counted nowhere"
    : priced
      ? `${usd(t.amount_exact_cents)} (shares × reported price)`
      : "no price filed";
  return {
    id: t.id,
    date: t.tx_date,
    side,
    sizeCents: priced ? t.amount_exact_cents : null,
    who: `${t.insider_name ?? "Unknown filer"}${role ? ` (${role})` : ""}`,
    amount,
  };
}

/** The shaded spans as text: the chart's table twin for the clusters. */
function SpanList({ spans }: { spans: ClusterSpan[] }) {
  if (!spans.length) {
    return (
      <p className="mt-3 px-1 text-[12px] text-muted-foreground">
        No span in this chart meets either cluster rule, so nothing is shaded.
      </p>
    );
  }
  const shown = spans.slice(-6).reverse();
  return (
    <ul className="mt-3 space-y-1 px-1 text-[12px] text-muted-foreground">
      {shown.map((s, i) => (
        <li key={i} className="flex items-start gap-1.5">
          <span
            aria-hidden
            className="mt-[5px] h-[3px] w-3 shrink-0 rounded-full"
            style={{ background: s.side === "buy" ? "var(--viz-buy)" : "var(--viz-sell)" }}
          />
          <span>
            <span className="font-medium text-ink-2">
              {s.source === "congress" ? "Members" : "Insiders"} {s.side === "buy" ? "buying" : "selling"}
            </span>{" "}
            · {fmtSpan(s.start, s.end)} · up to {s.peak} {s.source === "congress" ? "members" : "insiders"} within{" "}
            {s.source === "congress" ? CONGRESS_RULE.windowDays : INSIDER_RULE.windowDays} days
            {` (${listPeople(s.people)})`}
          </span>
        </li>
      ))}
      {spans.length > shown.length ? <li>{spans.length - shown.length} earlier span{spans.length - shown.length === 1 ? "" : "s"} shaded in the chart.</li> : null}
    </ul>
  );
}

function listPeople(people: string[]): string {
  return people.length > 6 ? `${people.slice(0, 6).join(", ")} and ${people.length - 6} more` : people.join(", ");
}

const FMT = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

function fmtSpan(a: string, b: string): string {
  const x = FMT.format(new Date(`${a}T00:00:00Z`));
  const y = FMT.format(new Date(`${b}T00:00:00Z`));
  return a === b ? x : `${x} – ${y}`;
}
