import { getInsiderTotals } from "@/lib/insider-queries";
import { BUY, CARD_SIZE, SELL, count, noun, renderPageCard } from "../share-card";

/**
 * The insider list's card. `?t=<SYMBOL>` is an issuer page with its own
 * card, app/cards/issuer/[symbol]. Form 4 counts only — never pooled with
 * the congressional figures.
 */

export const alt = "Corporate insider trades from SEC Form 4 on FatCat Watch: trades, issuers and buy/sell counts";
export const size = CARD_SIZE;
export const contentType = "image/png";
export const revalidate = 3600;

export default async function Image() {
  const stats = [];
  try {
    const t = await getInsiderTotals();
    stats.push(
      { value: count(t.trades), label: noun(t.trades, "insider trade") },
      { value: count(t.issuers), label: noun(t.issuers, "issuer") },
      { value: count(t.buys), label: noun(t.buys, "buy"), dot: BUY },
      { value: count(t.sells), label: noun(t.sells, "sell"), dot: SELL }
    );
  } catch {
    /* a database from before the insider source */
  }
  return renderPageCard({
    eyebrow: "Corporate insiders · SEC Form 4",
    title: "Corporate insider trades",
    subtitle: "Officers, directors and 10% owners buying and selling their own company's stock on the open market.",
    stats,
    footnote: "Filings of $50k or more in one direction · values on the site: shares × reported price",
  });
}
