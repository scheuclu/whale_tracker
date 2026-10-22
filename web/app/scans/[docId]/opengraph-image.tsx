import { getScanFilingSummary } from "@/lib/scan-queries";
import { CARD_SIZE, cardDate, count, noun, renderPageCard, renderPlainCard } from "../../share-card";

export const alt = "A scanned House STOCK Act filing on FatCat Watch: its captured pages and the rows the grid reader found";
export const size = CARD_SIZE;
export const contentType = "image/png";
export const revalidate = 3600;

export default async function Image({ params }: { params: Promise<{ docId: string }> }) {
  const docId = decodeURIComponent((await params).docId);
  let filing = null;
  try {
    filing = await getScanFilingSummary(docId);
  } catch {
    /* fall back to the plain card */
  }
  if (!filing) return renderPlainCard(`Scanned filing ${docId}`);

  const seat = [filing.party, filing.state].filter(Boolean).join("-");
  const filed = cardDate(filing.filing_date);
  return renderPageCard({
    eyebrow: `Scanned House filing ${filing.doc_id}`,
    title: `${filing.member_name}${seat ? ` (${seat})` : ""}`,
    subtitle: filed ? `Filed ${filed}, on paper` : "Filed on paper",
    stats: [
      { value: count(filing.pages), label: `${noun(filing.pages, "page")} captured` },
      { value: count(filing.rows), label: `${noun(filing.rows, "row")} found` },
      { value: count(filing.linked), label: `${noun(filing.linked, "row")} transcribed` },
    ],
    footnote: "Transcribed rows are shown on the page and never counted in any total",
  });
}
