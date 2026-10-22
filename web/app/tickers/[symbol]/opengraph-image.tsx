import { getTickerDetail } from "@/lib/queries";
import { BUY, CARD_SIZE, SELL, count, renderCard, renderPlainCard, INK, SERIF } from "../../share-card";

export const alt = "A ticker's congressional trades on FatCat Watch: members trading and buy/sell counts";
export const size = CARD_SIZE;
export const contentType = "image/png";
export const revalidate = 3600;

export default async function Image({ params }: { params: Promise<{ symbol: string }> }) {
  const symbol = decodeURIComponent((await params).symbol).toUpperCase();
  let stat = null;
  try {
    stat = await getTickerDetail(symbol);
  } catch {
    /* fall back to the plain card */
  }
  if (!stat) return renderPlainCard(symbol);

  const name = stat.asset_name ?? "";
  return renderCard({
    body: (
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", fontSize: 140, lineHeight: 1, letterSpacing: "-0.02em", fontFamily: SERIF }}>
          {stat.ticker}
        </div>
        {name ? (
          <div style={{ display: "flex", fontSize: 32, color: INK[2], maxWidth: 1050 }}>
            {name.length > 64 ? `${name.slice(0, 63)}…` : name}
          </div>
        ) : null}
      </div>
    ),
    stats: [
      { value: count(stat.politicians), label: stat.politicians === 1 ? "member trading" : "members trading" },
      { value: count(stat.trades), label: stat.trades === 1 ? "disclosed trade" : "disclosed trades" },
      { value: count(stat.buys), label: stat.buys === 1 ? "buy" : "buys", dot: BUY },
      { value: count(stat.sells), label: stat.sells === 1 ? "sell" : "sells", dot: SELL },
    ],
    footnote: [
      "House and Senate STOCK Act disclosures",
      stat.last_tx_date ? `last trade ${stat.last_tx_date}` : null,
      "amounts are filed as ranges",
    ]
      .filter(Boolean)
      .join(" · "),
  });
}
