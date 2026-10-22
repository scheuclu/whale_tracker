import { STOCK_ACT_DEADLINE_DAYS, getLateTotals, getPoliticianTotals } from "@/lib/queries";
import { CARD_SIZE, count, noun, renderPageCard } from "../../share-card";

/**
 * The card for `/politicians?view=late`. A query-string view cannot have a
 * file-based card in its own segment (the image route never sees the
 * search params), so the query-string views' cards live under app/cards/
 * and the page names them through `pageCard` (lib/seo.ts). This folder has
 * no page: `/cards/late` itself is a 404.
 */

export const alt = "Late STOCK Act disclosures on FatCat Watch: trades disclosed more than 45 days after the trade";
export const size = CARD_SIZE;
export const contentType = "image/png";
export const revalidate = 3600;

export default async function Image() {
  const stats = [];
  try {
    const [late, members] = await Promise.all([getLateTotals(), getPoliticianTotals()]);
    const share = late.trades ? `${((100 * late.late_trades) / late.trades).toFixed(1)}%` : "—";
    stats.push(
      { value: count(late.late_trades), label: `late ${noun(late.late_trades, "trade")}` },
      { value: share, label: `of ${count(late.trades)} trades` },
      { value: count(members.members_late), label: `${noun(members.members_late, "member")} late` },
      { value: count(late.late_filings), label: noun(late.late_filings, "filing") }
    );
  } catch {
    /* the card keeps its headline */
  }
  return renderPageCard({
    eyebrow: "House and Senate · STOCK Act",
    title: "Late disclosures",
    subtitle: `Trades disclosed more than ${STOCK_ACT_DEADLINE_DAYS} days after they were made. A late count is a reporting fact, not an allegation of wrongdoing.`,
    stats,
    footnote: "Delay is trade date to filing date, as filed",
  });
}
