import { getTrackLeaderboard, points } from "@/lib/track-queries";
import { CARD_SIZE, count, noun, renderPageCard } from "../../share-card";

/**
 * The card for `/politicians?view=track` (a query-string view: its card
 * lives under app/cards/, see app/cards/late). Counts and the base rate
 * only — no member is named on a card that travels without its caveats.
 */

export const alt =
  "Track record on FatCat Watch: how the stocks members of Congress traded moved afterwards against the S&P 500";
export const size = CARD_SIZE;
export const contentType = "image/png";
export const revalidate = 3600;

export default async function Image() {
  const stats = [];
  try {
    const board = await getTrackLeaderboard(90);
    const t = board.model.trade;
    const d = board.model.disclosure;
    if (board.available && t) {
      stats.push(
        { value: count(t.ranked), label: `${noun(t.ranked, "member")} ranked` },
        { value: count(t.decisions), label: `${noun(t.decisions, "decision")} measured` },
        { value: `${points(t.mean)} pts`, label: "avg. after trade" },
        { value: `${points(d?.mean ?? null)} pts`, label: "avg. after disclosure" }
      );
    }
  } catch {
    /* the card keeps its headline */
  }
  return renderPageCard({
    eyebrow: "House and Senate · 90 trading days",
    title: "Track record",
    subtitle:
      "Whose trades were followed by the biggest market-beating moves: each stock's move after the trade, against the S&P 500. Not their profit; not advice.",
    stats,
    footnote: "Stock's move minus SPY, signed by direction; brackets never enter it",
  });
}
