import { getConsensusTickers, getPipeline } from "@/lib/queries";
import { CARD_SIZE, Chips, INK, count, noun, renderPageCard } from "../share-card";

export const alt = "Stocks traded by members of Congress on FatCat Watch: tickers, trades, and the tickers the most members traded in the last 90 days";
export const size = CARD_SIZE;
export const contentType = "image/png";
export const revalidate = 3600;

export default async function Image() {
  const stats = [];
  let top: { ticker: string; politicians: number }[] = [];
  try {
    const [p, consensus] = await Promise.all([getPipeline(), getConsensusTickers(90, 6)]);
    stats.push(
      { value: count(p.totals.tickers), label: noun(p.totals.tickers, "ticker") },
      { value: count(p.totals.transactions), label: noun(p.totals.transactions, "disclosed trade") },
      { value: count(p.totals.members), label: `${noun(p.totals.members, "member")} trading` }
    );
    top = consensus.filter((t) => t.politicians > 1);
  } catch {
    /* the card keeps its headline */
  }
  return renderPageCard({
    eyebrow: "House and Senate · STOCK Act",
    title: "Stocks traded by members of Congress",
    extra: top.length ? (
      <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 6 }}>
        <div style={{ display: "flex", fontSize: 22, color: INK[3] }}>Most members trading, last 90 days</div>
        <Chips items={top.map((t) => `${t.ticker} · ${t.politicians}`)} />
      </div>
    ) : undefined,
    stats,
    footnote: "Counts by trade date · amounts are filed as ranges",
  });
}
