import { getScanTotals } from "@/lib/scan-queries";
import { CARD_SIZE, count, noun, renderPageCard } from "../share-card";

export const alt = "Scanned paper STOCK Act filings on FatCat Watch: filings, captured pages and the rows the grid reader found";
export const size = CARD_SIZE;
export const contentType = "image/png";
export const revalidate = 3600;

export default async function Image() {
  const stats = [];
  try {
    const t = await getScanTotals();
    stats.push(
      { value: count(t.filings), label: `scanned ${noun(t.filings, "filing")}` },
      { value: count(t.pages), label: `${noun(t.pages, "page")} captured` },
      { value: count(t.rows), label: `${noun(t.rows, "row")} found` }
    );
  } catch {
    /* a database from before the capture tables */
  }
  return renderPageCard({
    eyebrow: "House · scanned paper filings",
    title: "What the grid reader made of each page",
    subtitle: "Filings submitted as scanned paper, page by page. Transcribed rows are shown, never counted in any total.",
    stats,
    footnote: "An audit trail, not a statistic",
  });
}
