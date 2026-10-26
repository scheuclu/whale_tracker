import { getPipeline, getPoliticianTotals } from "@/lib/queries";
import { CARD_SIZE, count, noun, renderPageCard } from "../share-card";

export const alt = "Members of Congress trading stocks on FatCat Watch: members, disclosed trades and late disclosures";
export const size = CARD_SIZE;
export const contentType = "image/png";
export const revalidate = 3600;

/** The roster card. `?committee=` has its own under app/cards/, as do the /rankings views. */
export default async function Image() {
  const stats = [];
  try {
    const [totals, p] = await Promise.all([getPoliticianTotals(), getPipeline()]);
    stats.push(
      { value: count(totals.members), label: `${noun(totals.members, "member")} trading` },
      { value: count(p.totals.transactions), label: noun(p.totals.transactions, "disclosed trade") },
      { value: count(p.totals.tickers), label: noun(p.totals.tickers, "ticker") },
      { value: count(totals.members_late), label: `${noun(totals.members_late, "member")} filed late` }
    );
  } catch {
    /* the card keeps its headline */
  }
  return renderPageCard({
    eyebrow: "House and Senate · STOCK Act",
    title: "Members of Congress trading stocks",
    subtitle: "Every member with a disclosed trade, ranked by trades, tickers and late filings.",
    stats,
    footnote: "Late: disclosed more than 45 days after the trade · amounts are filed as ranges",
  });
}
