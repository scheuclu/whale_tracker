import { getPipeline } from "@/lib/queries";
import { CARD_SIZE, Chips, cardDate, count, noun, renderPageCard } from "../share-card";

export const alt = "FatCat Watch data pipeline: filings indexed, trades parsed, unreadable filings and the last sync";
export const size = CARD_SIZE;
export const contentType = "image/png";
export const revalidate = 3600;

export default async function Image() {
  const stats = [];
  try {
    const p = await getPipeline();
    stats.push(
      { value: count(p.totals.filings), label: `${noun(p.totals.filings, "filing")} indexed` },
      { value: count(p.totals.transactions), label: `${noun(p.totals.transactions, "trade")} parsed` },
      { value: count(p.coverage.unreadable ?? 0), label: "not yet readable" }
    );
    const synced = cardDate(p.lastUpdated);
    if (synced) stats.push({ value: synced, label: "last sync" });
  } catch {
    /* the card keeps its headline */
  }
  return renderPageCard({
    eyebrow: "Data pipeline",
    title: "Coverage and freshness",
    subtitle: "How current and complete the data is, and the state of each source.",
    extra: <Chips items={["US House Clerk", "US Senate eFD", "SEC EDGAR"]} />,
    stats,
    footnote: "Congressional filings: House and Senate STOCK Act · insider filings: SEC Form 4",
  });
}
