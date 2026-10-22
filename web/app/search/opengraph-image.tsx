import { CARD_SIZE, Chips, renderPageCard } from "../share-card";

export const alt = "Search FatCat Watch for a member of Congress, a ticker or a corporate insider issuer";
export const size = CARD_SIZE;
export const contentType = "image/png";

/** Generic on purpose: a results page is a query, and the query is not in the card. No database. */
export default function Image() {
  return renderPageCard({
    eyebrow: "Search",
    title: "Find a member, a ticker or an insider issuer",
    extra: <Chips items={["Members of Congress", "Tickers", "Corporate insider issuers"]} />,
    stats: [],
    footnote: "US congressional (STOCK Act) and corporate-insider (SEC Form 4) stock trades",
  });
}
