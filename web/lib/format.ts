/**
 * Display helpers.
 *
 * Congressional amounts are disclosure *brackets*, not figures the member
 * reported. These helpers keep that distinction visible: `usd` renders a
 * point estimate and is only ever used where the label says "est.", while
 * `range` renders what was actually disclosed. Insider (Form 4) values are
 * the exception — shares × the reported price, exact but computed — and are
 * labelled as such wherever they appear.
 */

export function usd(cents: number | null | undefined): string {
  if (cents == null) return "—";
  const d = cents / 100;
  if (d >= 1_000_000) return `$${(d / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (d >= 10_000) return `$${Math.round(d / 1_000).toLocaleString()}k`;
  return `$${Math.round(d).toLocaleString()}`;
}

/** The disclosed interval. An open-ended top bracket renders as "≥$50M". */
export function range(
  min: number | null,
  max: number | null,
  exact?: number | null
): string {
  if (exact != null) return usd(exact);
  if (min == null) return "—";
  if (max == null) return `≥${usd(min)}`;
  if (min === max) return usd(min);
  return `${usd(min)}–${usd(max)}`;
}

export const ACTION_LABEL: Record<string, string> = {
  purchase: "Buy",
  sale: "Sell",
  sale_partial: "Sell (partial)",
  exchange: "Exchange",
};

export function isBuy(action: string): boolean {
  return action === "purchase";
}

export function isSell(action: string): boolean {
  return action === "sale" || action === "sale_partial";
}

/** A strike as printed on a contract: $120, or $11.80 when it is not whole. */
export function strikeUsd(cents: number): string {
  const whole = cents % 100 === 0;
  return `$${(cents / 100).toLocaleString(undefined, {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * The parsed option contract — "CALL · $120 · exp 01/16/27". Only what the
 * filing printed: a kind alone is still a fact, and a missing strike is left
 * out rather than shown as a placeholder. Mirrors `describe` in
 * src/whale/options.py.
 */
export function optionLabel(
  kind: string | null,
  strikeCents: number | null,
  expiry: string | null
): string | null {
  if (!kind) return null;
  const parts = [kind.toUpperCase()];
  if (strikeCents != null) parts.push(strikeUsd(strikeCents));
  if (expiry) parts.push(`exp ${shortDate(expiry)}`);
  return parts.join(" · ");
}

export const OWNER_LABEL: Record<string, string> = {
  SP: "spouse",
  DC: "dependent child",
  JT: "joint",
};

/** Asset type codes from fd.house.gov/reference/asset-type-codes.aspx. */
export const ASSET_TYPE_LABEL: Record<string, string> = {
  ST: "Stock",
  OP: "Options",
  EF: "ETF",
  ET: "ETN",
  CT: "Crypto",
  RS: "RSUs",
  SA: "Stock appreciation right",
  GS: "Government / agency debt",
  CS: "Corporate bond or note",
  MF: "Mutual fund",
  RE: "REIT",
  OT: "Other",
  PS: "Private stock",
  HN: "Hedge / PE fund",
  AB: "Asset-backed security",
  VA: "Variable annuity",
  OL: "Business ownership",
  IR: "IRA",
  BA: "Bank account",
};

export function memberLabel(
  name: string,
  party: string | null,
  state: string | null,
  district: string | null,
  chamber: string | null
): string {
  const title = chamber === "senate" ? "Sen." : "Rep.";
  const where = [party, state ? `${state}${district && district !== "0" ? district : ""}` : null]
    .filter(Boolean)
    .join("-");
  return where ? `${title} ${name} (${where})` : `${title} ${name}`;
}

/** The member's page. Keyed on the display name: that is how the leaderboard
 *  groups, and an unmatched filing has only the name printed on the PDF. */
export function memberHref(name: string, action?: string): string {
  return `/politicians?m=${encodeURIComponent(name)}${action ? `&action=${action}` : ""}`;
}

export function shortDate(iso: string | null): string {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  if (!y || !m || !d) return iso;
  return `${m}/${d}/${y.slice(2)}`;
}

export function relativeTime(iso: string | null): string {
  if (!iso) return "never";
  const then = Date.parse(iso.replace(" ", "T"));
  if (Number.isNaN(then)) return iso;
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Share counts as filed; fractional shares keep up to two decimals. */
export function shares(n: number | null | undefined): string {
  if (n == null) return "—";
  return n.toLocaleString(undefined, { maximumFractionDigits: Number.isInteger(n) ? 0 : 2 });
}

/** Price per share as filed — filers report up to four decimals. */
export function price(n: number | null | undefined): string {
  if (n == null) return "—";
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
}
