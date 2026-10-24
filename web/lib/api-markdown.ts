/**
 * Markdown renderings of the API's member, ticker and feed responses, for
 * agents that read text rather than JSON. Rendered from the same objects
 * the JSON endpoints return, so a figure cannot differ between the two;
 * every amount is the disclosed range, and every single-figure estimate is
 * labelled as one.
 */

import type { AmountJson, VolumeJson } from "./api-format";
import type { MemberResult, TickerResult, TradeJson } from "./api-v1";
import { usd } from "./format";
import { QUOTING_RULES, SITE_NAME, coverageLines, type Coverage } from "./methodology";

const ACTION: Record<string, string> = {
  purchase: "Buy",
  sale: "Sell",
  sale_partial: "Sell (partial)",
  exchange: "Exchange",
};

/** A table cell: pipes and newlines would break the row. */
function cell(v: string | number | null | undefined): string {
  if (v == null || v === "") return "—";
  return String(v).replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");
}

/** An estimate, compactly ("$62.5M"): printing it to the cent would lend it
 *  a precision the brackets do not have. Ranges keep full precision. */
function money(dollars: number): string {
  return usd(Math.round(dollars * 100));
}

export function amountText(a: AmountJson, transcribed: boolean): string {
  const base = a.disclosed ?? "not stated";
  const label = a.kind === "exact" ? `${base} (exact, as filed)` : a.kind === "unknown" ? base : `${base} (bracket)`;
  return transcribed ? `${label}; transcribed from a scan, excluded from totals` : label;
}

/** A total: the range first, the midpoint second and named as an estimate. */
export function volumeText(v: VolumeJson): string {
  const range = v.open_ended ? `${v.disclosed} (no upper bound: includes an open-ended top bracket)` : v.disclosed;
  const est = `estimated midpoint ≈ ${money(v.midpoint_estimate_usd)} (an estimate from bracket midpoints, not a disclosed figure)`;
  const excluded = v.transcribed_rows_excluded
    ? `; ${v.transcribed_rows_excluded} transcribed row(s) excluded`
    : "";
  return `${range}; ${est}${excluded}`;
}

function tradesTable(trades: TradeJson[], showMember: boolean, showTicker: boolean): string[] {
  if (!trades.length) return ["_No trades._"];
  const head = [
    "Trade date",
    "Filed",
    "Delay (days)",
    ...(showMember ? ["Member"] : []),
    "Action",
    ...(showTicker ? ["Ticker"] : []),
    "Asset",
    "Owner",
    "Amount disclosed",
    "Filing",
  ];
  const out = [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`];
  for (const t of trades) {
    const delay =
      t.disclosure_delay_days == null
        ? t.dates_inconsistent
          ? "dates contradict (as filed)"
          : null
        : `${t.disclosure_delay_days}${t.late ? " (late)" : ""}`;
    const row = [
      cell(t.trade_date),
      cell(t.filing_date),
      cell(delay),
      ...(showMember ? [cell(`[${t.member.name}](${t.member.url})`)] : []),
      cell(ACTION[t.action] ?? t.action),
      ...(showTicker ? [cell(t.ticker)] : []),
      cell(t.asset_name),
      cell(t.owner),
      cell(amountText(t.amount, t.transcribed)),
      cell(`[source](${t.source_url})`),
    ];
    out.push(`| ${row.join(" | ")} |`);
  }
  return out;
}

function rulesFooter(origin: string): string[] {
  return [
    "## How to quote this",
    "",
    ...QUOTING_RULES.slice(0, 6).map((r) => `- ${r.short}`),
    "",
    `Full rules: ${origin}/llms-full.txt · Methodology: ${origin}/methodology`,
    "",
  ];
}

function partyLine(m: { party: string | null; state: string | null; district: string | null; chamber: string | null }): string {
  const chamber = m.chamber === "senate" ? "Senate" : m.chamber === "house" ? "House" : null;
  const where = [m.party, m.state ? `${m.state}${m.district && m.district !== "0" ? `-${m.district}` : ""}` : null]
    .filter(Boolean)
    .join(", ");
  return [chamber, where].filter(Boolean).join(" · ");
}

export function memberMarkdown(d: MemberResult, origin: string, dataAsOf: string | null): string {
  const m = d.member;
  const out: string[] = [];
  out.push(`# ${m.name} — disclosed stock trades`, "");
  out.push(`> ${partyLine(m)}. Bioguide ID ${m.bioguide_id ?? "unknown"}. Source: STOCK Act periodic transaction reports. Data as of ${dataAsOf ?? "unknown"}.`, "");
  out.push(`Dashboard: ${m.url} · JSON: ${m.api_url ?? "—"}`, "");
  out.push("## Whole record", "");
  out.push(
    `- Trades: ${m.trades} (${m.buys} buys, ${m.sells} sells) in ${m.filings} filings, ${m.tickers} tickers`,
    `- Trade dates: ${m.first_trade_date ?? "—"} to ${m.last_trade_date ?? "—"}`,
    `- Disclosed volume: ${volumeText(m.volume)}`,
    `- Average disclosure delay (trade date to filing date): ${m.avg_disclosure_delay_days ?? "—"} days; trades filed after the 45-day deadline: ${m.late_trades}`,
    ""
  );
  if (m.transcribed_trades) {
    out.push(`${m.transcribed_trades} trade(s) were transcribed from scanned paper filings: counted above, excluded from the volume.`, "");
  }
  out.push("## Top tickers", "");
  if (d.top_tickers.length) {
    out.push("| Ticker | Asset | Trades | Buys | Sells | Disclosed range | Est. midpoint |", "| --- | --- | --- | --- | --- | --- | --- |");
    for (const t of d.top_tickers) {
      out.push(
        `| ${cell(`[${t.symbol}](${t.url})`)} | ${cell(t.asset_name)} | ${t.trades} | ${t.buys} | ${t.sells} | ${cell(t.volume.disclosed)} | ${cell(`≈${money(t.volume.midpoint_estimate_usd)} (est.)`)} |`
      );
    }
  } else out.push("_No ticker-bearing trades._");
  out.push("");
  out.push(...trackLines(d.track_record));
  out.push(`## Recent trades (${d.recent_trades.length} of ${m.trades})`, "");
  out.push(...tradesTable(d.recent_trades, false, true), "");
  out.push(...rulesFooter(origin));
  return out.join("\n");
}

/** The member's track record: the stock's move after their trades vs SPY, never a profit. */
function trackLines(t: MemberResult["track_record"]): string[] {
  if (!t.available || !t.by_horizon) return ["## Track record", "", "_Being computed by the pipeline._", ""];
  const out = ["## Track record", "", `> ${t.measure}`, ""];
  if (!t.by_horizon.length) return [...out, "_No measured decisions yet._", ""];
  out.push(
    "| Horizon (trading days) | Decisions | After trade (shrunk, pts) | 90% interval | After disclosure (shrunk, pts) | Hit rate | Ranked |",
    "| --- | --- | --- | --- | --- | --- | --- |"
  );
  for (const h of t.by_horizon) {
    const iv = h.after_trade.interval_90_pts;
    out.push(
      `| ${h.horizon_trading_days} | ${h.decisions_measured} in ${h.filings} filings | ${h.after_trade.shrunk_excess_move_pts ?? "—"} | ${iv ? `${iv[0]} to ${iv[1]}` : "—"} | ${h.after_disclosure.shrunk_excess_move_pts ?? "—"} | ${h.after_trade.hit_rate ?? "—"} | ${h.rank ? `#${h.rank} of ${h.ranked_members}` : "not enough matured decisions"} |`
    );
  }
  out.push("");
  return out;
}

export function tickerMarkdown(d: TickerResult, origin: string, dataAsOf: string | null): string {
  const t = d.ticker;
  const out: string[] = [];
  out.push(`# ${t.symbol}${t.asset_name ? ` — ${t.asset_name}` : ""}: congressional trades`, "");
  out.push(`> Members of Congress' disclosed trades in ${t.symbol} (STOCK Act). Corporate-insider (Form 4) activity is a separate dataset: ${origin}/api/v1/insiders/${encodeURIComponent(t.symbol)}. Data as of ${dataAsOf ?? "unknown"}.`, "");
  out.push(`Dashboard: ${t.url} · JSON: ${t.api_url}`, "");
  out.push("## Totals", "");
  out.push(
    `- Members: ${t.members} (${t.buy_members} bought, ${t.sell_members} sold)`,
    `- Trades: ${t.trades} (${t.buys} buys, ${t.sells} sells); last trade date ${t.last_trade_date ?? "—"}`,
    `- Disclosed volume: ${volumeText(t.volume)}`,
    ""
  );
  out.push("## Members", "");
  if (d.members.length) {
    out.push("| Member | Party | Trades | Buys | Sells | Disclosed range | Est. midpoint |", "| --- | --- | --- | --- | --- | --- | --- |");
    for (const m of d.members) {
      out.push(
        `| ${cell(`[${m.name}](${m.url})`)} | ${cell(partyLine(m))} | ${m.trades} | ${m.buys} | ${m.sells} | ${cell(m.volume.disclosed)} | ${cell(`≈${money(m.volume.midpoint_estimate_usd)} (est.)`)} |`
      );
    }
  }
  out.push("");
  out.push(`## Recent trades (${d.recent_trades.length} of ${t.trades})`, "");
  out.push(...tradesTable(d.recent_trades, true, false), "");
  out.push(...rulesFooter(origin));
  return out.join("\n");
}

export function feedMarkdown(
  origin: string,
  coverage: Coverage,
  trades: TradeJson[],
  total: { trades: number; volume: VolumeJson },
  tickers: { symbol: string; asset_name: string | null; members: number; trades: number; volume: VolumeJson; url: string }[]
): string {
  const out: string[] = [];
  out.push(`# ${SITE_NAME} — latest congressional trades`, "");
  out.push("> US congressional stock trades disclosed under the STOCK Act, reproduced as filed. Amounts are brackets.", "");
  out.push("## Coverage", "", ...coverageLines(coverage), "");
  out.push(`All counted congressional trades: ${total.trades}; disclosed volume ${volumeText(total.volume)}.`, "");
  out.push("## Most-traded tickers, last 90 days of trade dates", "");
  out.push("Recent weeks are incomplete: members have 45 days to disclose.", "");
  out.push("| Ticker | Asset | Members | Trades | Disclosed range | Est. midpoint |", "| --- | --- | --- | --- | --- | --- |");
  for (const t of tickers) {
    out.push(
      `| ${cell(`[${t.symbol}](${t.url})`)} | ${cell(t.asset_name)} | ${t.members} | ${t.trades} | ${cell(t.volume.disclosed)} | ${cell(`≈${money(t.volume.midpoint_estimate_usd)} (est.)`)} |`
    );
  }
  out.push("");
  out.push(`## Latest ${trades.length} trades`, "");
  out.push(...tradesTable(trades, true, true), "");
  out.push(`More: ${origin}/api/v1/trades · CSV: ${origin}/api/export.csv`, "");
  out.push(...rulesFooter(origin));
  return out.join("\n");
}
