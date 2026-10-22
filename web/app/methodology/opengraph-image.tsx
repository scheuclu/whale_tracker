import { QUOTING_RULES } from "@/lib/methodology";
import { CARD_SIZE, INK, renderPageCard, GOLD } from "../share-card";

export const alt =
  "FatCat Watch methodology: congressional amounts are ranges, delay is trade date to filing date, insider values are shares × reported price";
export const size = CARD_SIZE;
export const contentType = "image/png";

/** The rules a quote most often gets wrong, in their /methodology words. No database. */
const SHOWN = ["amounts-are-ranges", "disclosure-delay", "insider-values", "transcribed-excluded"];

export default function Image() {
  const rules = SHOWN.map((id) => QUOTING_RULES.find((r) => r.id === id)?.title).filter((t): t is string => !!t);
  return renderPageCard({
    eyebrow: "Methodology",
    title: "How every figure is sourced and computed",
    extra: (
      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 10 }}>
        {rules.map((r) => (
          <div key={r} style={{ display: "flex", alignItems: "center", gap: 16, fontSize: 28, color: INK[2] }}>
            <div style={{ display: "flex", width: 10, height: 10, borderRadius: 5, backgroundColor: GOLD }} />
            {r}
          </div>
        ))}
      </div>
    ),
    stats: [],
    footnote: "House Clerk · Senate eFD · SEC EDGAR · a disclosed trade is not evidence of wrongdoing",
  });
}
