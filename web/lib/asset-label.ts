/**
 * Display-only cleanup of the asset names filers print.
 *
 * The stored `asset_name` is reproduced exactly as filed and is never
 * changed (CLAUDE.md: reproduce what was filed). This only shortens what a
 * list shows, so "Intel Corporation - Common Stock" reads "Intel
 * Corporation" beside its INTC chip. Callers put the original in a `title`,
 * so the full filed text is always one hover away.
 *
 * What is removed, and nothing else:
 *
 * - **Residue after the asset-type slot.** A PTR's asset cell ends with its
 *   type code, "(AMZN) [ST]"; text after the code is the description or
 *   location line the parser picked up beside it ("1/16/26.", "advisors. I
 *   have no role in…", "Francisco, CA."). The cut happens at the first
 *   " [XX]" code.
 * - **The row's own ticker in parentheses** at the end, when it matches the
 *   ticker the row already shows. A symbol the row does not show (a filing
 *   whose ticker column was empty) stays: it is the only place it appears.
 * - **Plain-equity boilerplate at the end**: "Common Stock", "Common
 *   Shares", "Ordinary Share(s)", "CMN", with an optional leading dash. A
 *   share class or series in front of it is kept ("Class A Common Stock" →
 *   "Class A", "Series A Common Stock" → "Series A"), as is a class after
 *   it ("CMN CLASS A" → "CLASS A").
 * - Doubled whitespace and a dangling trailing comma or dash.
 *
 * Never removed: anything not at the very end (so "Common Stock ADR",
 * "Common Stock When-Issued", "Common Shares of Beneficial Interest" and
 * "Common Units…" survive intact), and any name mentioning depositary
 * shares. Preferred, warrants, notes, units, rates and series are never
 * matched at all. If cleaning would leave nothing ("Common Stock" as a
 * security title), the original is returned.
 */

/** The first PTR asset-type code: " [ST]", " [GS]", and the mistyped "[MF}". */
const TYPE_SLOT = /\s*\[[A-Z]{2}[\]}]/;

/** A trailing "(SYM)": ticker-shaped, so "(new)" or "(Sponsored)" never match. */
const TRAILING_SYMBOL = /\s*\(([A-Z][A-Z0-9]{0,5}(?:[.\-][A-Z0-9]{1,3})?)\)$/;

/**
 * Plain-equity boilerplate at the end of the name. Not after "New": a bare
 * "Berkshire Hathaway Inc. New" would read worse than the filed text.
 */
const EQUITY_TAIL =
  /(?<!\bNew\s*)\s*(?:[-–—]\s*)?(?:\b((?:Class|Series)\s+[A-Z0-9]{1,3})\s+)?\b(?:Common\s+(?:Stock|Shares)|Ordinary\s+Shares?|CMN)(?:\s+(Class\s+[A-Z0-9]{1,3}))?$/i;

const DANGLING = /[\s,;:\-–—]+$/;

function trimTail(s: string): string {
  return s.replace(DANGLING, "");
}

export function assetLabel(name: string | null | undefined, opts: { ticker?: string | null } = {}): string {
  if (!name) return "";
  const original = name.replace(/\s+/g, " ").trim();
  let s = original;

  const slot = s.search(TYPE_SLOT);
  if (slot > 0) s = s.slice(0, slot);
  s = trimTail(s);

  // Detach a trailing symbol so the boilerplate in front of it can go; put
  // it back unless the row already shows that same ticker.
  let symbol = "";
  const sym = s.match(TRAILING_SYMBOL);
  if (sym && sym.index && sym.index > 0) {
    s = trimTail(s.slice(0, sym.index));
    const shown = opts.ticker?.trim().toUpperCase();
    if (!shown || sym[1].toUpperCase() !== shown) symbol = sym[1];
  }

  if (!/depositary/i.test(s)) {
    s = s.replace(EQUITY_TAIL, (_m, before?: string, after?: string) => {
      const q = before ?? after;
      return q ? ` ${q}` : "";
    });
    s = trimTail(s.trim());
  }

  if (symbol) s = `${s} (${symbol})`;
  return s.length >= 2 ? s : original;
}
