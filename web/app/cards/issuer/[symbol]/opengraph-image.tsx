import { getInsiderIssuer } from "@/lib/insider-queries";
import { BUY, CARD_SIZE, SELL, cardDate, count, noun, renderPageCard, renderPlainCard } from "../../../share-card";

/**
 * The card for `/insiders?t=<SYMBOL>` (see app/cards/late for why it lives
 * here). Counts only, from SEC Form 4: never pooled with congressional data.
 */

export const alt = "A company's corporate-insider trades from SEC Form 4 on FatCat Watch: insiders, filings and buy/sell counts";
export const size = CARD_SIZE;
export const contentType = "image/png";
export const revalidate = 3600;

export default async function Image({ params }: { params: Promise<{ symbol: string }> }) {
  const symbol = decodeURIComponent((await params).symbol).toUpperCase();
  let issuer = null;
  try {
    issuer = await getInsiderIssuer(symbol);
  } catch {
    /* fall back to the plain card */
  }
  if (!issuer) return renderPlainCard(symbol, "Corporate insider trades · SEC Form 4");

  const last = cardDate(issuer.last_tx_date);
  return renderPageCard({
    eyebrow: "Corporate insiders · SEC Form 4",
    title: issuer.ticker ?? symbol,
    mono: true,
    subtitle: issuer.issuer_name ?? undefined,
    stats: [
      { value: count(issuer.insiders), label: noun(issuer.insiders, "insider") },
      { value: count(issuer.filings), label: noun(issuer.filings, "filing") },
      { value: count(issuer.buys), label: noun(issuer.buys, "buy"), dot: BUY },
      { value: count(issuer.sells), label: noun(issuer.sells, "sell"), dot: SELL },
    ],
    footnote: ["Open-market purchases and sales", last ? `last trade ${last}` : null, "values on the page: shares × reported price"]
      .filter(Boolean)
      .join(" · "),
  });
}
