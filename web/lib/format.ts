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

/**
 * Compact dollars from cents: $950, $12,500 → $13k, $62.5M, $2.9B, $1.2T.
 *
 * The unit is chosen *after* rounding, so a figure never reads as 1,000 of a
 * unit ("$1000M", "$1,000k") when it rounds up to the next one — and a
 * value past a billion is never written as thousands of millions ("$2883M").
 */
export function usd(cents: number | null | undefined): string {
  if (cents == null || !Number.isFinite(cents)) return "—";
  const d = cents / 100;
  const sign = d < 0 ? "-" : "";
  const a = Math.abs(d);
  if (a >= 1e6) {
    const units: [number, string][] = [
      [1e6, "M"],
      [1e9, "B"],
      [1e12, "T"],
    ];
    let i = 0;
    while (i < units.length - 1 && a >= units[i + 1][0]) i++;
    let v = Number((a / units[i][0]).toFixed(1));
    // $999.96M rounds to 1000.0M: that is $1B.
    if (v >= 1000 && i < units.length - 1) v = Number((a / units[++i][0]).toFixed(1));
    return `${sign}$${v.toFixed(1).replace(/\.0$/, "")}${units[i][1]}`;
  }
  if (a >= 10_000) {
    const k = Math.round(a / 1_000);
    // $999,600 rounds to 1,000k: that is $1M.
    return k >= 1_000 ? `${sign}$1M` : `${sign}$${k.toLocaleString("en-US")}k`;
  }
  return `${sign}$${Math.round(a).toLocaleString("en-US")}`;
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

/**
 * The slug of a name: accents folded, lower case, every run of anything that
 * is not a letter or digit collapsed to one hyphen. "Gilbert Ray Cisneros,
 * Jr." → "gilbert-ray-cisneros-jr". Mirrored by `_slugify` in
 * src/whale/telegram.py; keep the two in agreement.
 */
export function slugify(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const BIOGUIDE_ID = /^[A-Z]\d{6}$/;
const SLUG_BIOGUIDE = /-([a-z]\d{6})$/;

/**
 * A member's URL slug. Roster-matched members are keyed on the bioguide id,
 * with the name in front for the reader: `nancy-pelosi-p000197`. The id is
 * what makes the URL stable — names collide, and the roster's spelling of
 * one changes — so the name part is cosmetic: a stale one redirects to the
 * current spelling. A filer the roster could not match has only the name
 * printed on the PDF, so the slug is that name alone.
 */
export function memberSlug(name: string, bioguideId?: string | null): string {
  const base = slugify(name) || "member";
  return bioguideId && BIOGUIDE_ID.test(bioguideId) ? `${base}-${bioguideId.toLowerCase()}` : base;
}

/** The bioguide id a slug ends in (upper-cased), or null for a name-only slug. */
export function slugBioguide(slug: string): string | null {
  const m = SLUG_BIOGUIDE.exec(slug.toLowerCase());
  return m ? m[1].toUpperCase() : null;
}

/**
 * The member's page, `/members/<slug>`. Pass the bioguide id whenever the
 * row has one: without it the link is the name-only slug, which still
 * resolves but costs the reader a redirect to the canonical URL. A filter
 * (`action=buy|sell`) stays a query parameter on the same page.
 */
export function memberHref(name: string, bioguideId?: string | null, action?: string): string {
  const path = `/members/${memberSlug(name, bioguideId)}`;
  return action ? `${path}?action=${encodeURIComponent(action)}` : path;
}

/**
 * A ticker's page, `/tickers/<SYMBOL>`. Symbols are stored upper case and
 * may carry a class suffix (`BRK.B`, `MOG.A`); the segment is encoded so
 * anything else a filing printed still round-trips.
 */
export function tickerHref(symbol: string): string {
  return `/tickers/${encodeURIComponent(symbol.toUpperCase())}`;
}

/** An issuer's Form 4 insider page. */
export function insiderIssuerHref(symbol: string): string {
  return `/insiders?t=${encodeURIComponent(symbol.toUpperCase())}`;
}

/** One committee's roster with each seat holder's trading totals, keyed on
 *  its thomas_id ('HSIF'; 'HSIF16' for a subcommittee). */
export function committeeHref(id: string): string {
  return `/politicians?committee=${encodeURIComponent(id)}`;
}

export function shortDate(iso: string | null): string {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  if (!y || !m || !d) return iso;
  return `${m}/${d}/${y.slice(2)}`;
}

/** A run's wall-clock duration: "48s", "3m 05s", "1h 12m". */
export function duration(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "—";
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
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

/**
 * A Telegram message as plain text. The bot sends HTML parse mode — <b>,
 * <i> and escaped &amp; &lt; &gt; — and the alert log keeps that text
 * exactly as sent, so the page strips the tags and restores the entities
 * rather than re-rendering anything.
 */
export function telegramPlainText(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
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
