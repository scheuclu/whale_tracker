/**
 * Member identity helpers: the official portrait, the monogram shown when
 * there is none, and the one-line summary on a member's profile.
 *
 * Portraits are the public-domain official photos mirrored by the
 * unitedstates/images project, keyed on the bioguide id. A handful of
 * members (new or appointed) have none yet, so every caller must be able to
 * fall back to the monogram.
 */

/** Bioguide ids are one capital letter and six digits: `P000197`. */
const BIOGUIDE = /^[A-Z]\d{6}$/;

export const PORTRAIT_ORIGIN = "https://unitedstates.github.io";
export const PORTRAIT_PATH = "/images/congress";

/**
 * The portrait's URL, or null when the id is missing or malformed. The id is
 * validated rather than escaped: it is interpolated into a path the image
 * optimizer will fetch, and a value that is not a bioguide id has no
 * portrait anyway.
 */
export function portraitUrl(
  bioguideId: string | null | undefined,
  size: "225x275" | "450x550" = "225x275"
): string | null {
  if (!bioguideId || !BIOGUIDE.test(bioguideId)) return null;
  return `${PORTRAIT_ORIGIN}${PORTRAIT_PATH}/${size}/${bioguideId}.jpg`;
}

const SUFFIX = /^(jr|sr|ii|iii|iv|v|md|phd)\.?$/i;

/**
 * Two-letter monogram: first and last name, skipping middle initials and
 * generational suffixes, so "Nicholas J. Begich III" reads "NB". A
 * single-word name gives one letter; an empty one gives "?".
 */
export function initials(name: string | null | undefined): string {
  const words = (name ?? "")
    .replace(/,/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}]+|[^\p{L}.]+$/gu, ""))
    .filter((w) => w && !SUFFIX.test(w));
  if (!words.length) return "?";
  const named = words.filter((w) => !/^\p{L}\.?$/u.test(w));
  const pool = named.length ? named : words;
  const first = pool[0][0];
  const last = pool.length > 1 ? pool[pool.length - 1][0] : "";
  return (first + last).toUpperCase();
}

export const PARTY_LABEL: Record<string, string> = {
  D: "Democrat",
  R: "Republican",
  I: "Independent",
  L: "Libertarian",
};

/** "House · CA-11", "Senate · AL", or null for a filer not on the roster. */
export function seatLabel(
  chamber: string | null | undefined,
  state: string | null | undefined,
  district: string | null | undefined
): string | null {
  const house = chamber === "senate" ? "Senate" : chamber === "house" ? "House" : null;
  if (!house) return null;
  const seat = state ? `${state}${district && district !== "0" ? `-${district}` : ""}` : null;
  return seat ? `${house} · ${seat}` : house;
}

const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Dec 24, 2025" from an ISO date, read as written (no timezone shift). */
export function longDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const [y, m, d] = iso.slice(0, 10).split("-");
  const name = MONTH[Number(m) - 1];
  if (!y || !name || !d) return iso;
  return `${name} ${Number(d)}, ${y}`;
}

/**
 * The plain-language line under a member's name, computed from their whole
 * record: "28 trades across 10 tickers, mostly buys". "Mostly" needs a 2:1
 * majority of the directional trades; anything closer is called a mix, and
 * exchanges are neither. Never a dollar figure — the stat tiles carry the
 * estimate, labelled as one.
 */
export function tradeSummary(r: {
  trades: number;
  tickers: number;
  buys: number;
  sells: number;
}): string {
  const parts = [`${r.trades} trade${r.trades === 1 ? "" : "s"}`];
  if (r.tickers > 0) parts[0] += ` across ${r.tickers} ticker${r.tickers === 1 ? "" : "s"}`;
  const directional = r.buys + r.sells;
  let lean: string | null = null;
  if (directional > 0) {
    if (r.sells === 0) lean = r.buys === 1 ? "a buy" : "all buys";
    else if (r.buys === 0) lean = r.sells === 1 ? "a sell" : "all sells";
    else if (r.buys >= 2 * r.sells) lean = "mostly buys";
    else if (r.sells >= 2 * r.buys) lean = "mostly sells";
    else lean = "a mix of buys and sells";
  }
  return lean ? `${parts[0]}, ${lean}` : parts[0];
}
