import { CARD_SIZE, Chips, renderPageCard } from "../share-card";

export const alt = "Ask FatCat: questions about congressional and insider stock trades, answered from the filings";
export const size = CARD_SIZE;
export const contentType = "image/png";

/** Generic: a conversation is private to the reader's tab, so the card names only the feature. No database. */
export default function Image() {
  return renderPageCard({
    eyebrow: "Ask FatCat",
    title: "Ask about the trades, in plain English",
    extra: <Chips items={["Members of Congress", "Tickers", "SEC Form 4 insiders"]} />,
    stats: [],
    footnote: "Answers from STOCK Act and SEC Form 4 filings, with links to the source",
  });
}
