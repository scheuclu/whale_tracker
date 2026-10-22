import { getMonthlyTrades, type MonthlyTrades } from "@/lib/trend-queries";
import { BUY, CARD_SIZE, INK, SELL, count, renderPageCard } from "../share-card";

export const alt =
  "Congressional stock trades by month on FatCat Watch: purchases above the line and sales below it, for the last 12 months by trade date";
export const size = CARD_SIZE;
export const contentType = "image/png";
export const revalidate = 3600;

const MONTHS = 12;
const HALF = 64;

/**
 * Trades per month as diverging columns: purchases up in blue, sales down
 * in red, both named in the legend. Counts, never amounts. On trade date,
 * so the newest months are part-filled by construction (45-day deadline);
 * the footnote says so rather than hiding the short bars.
 */
function Columns({ months }: { months: MonthlyTrades[] }) {
  const max = Math.max(1, ...months.map((m) => Math.max(m.buys, m.sells)));
  const h = (n: number) => (n ? Math.max(2, Math.round((HALF * n) / max)) : 0);
  return (
    <div style={{ display: "flex", flexDirection: "column", marginTop: 14 }}>
      <div style={{ display: "flex", gap: 14 }}>
        {months.map((m) => (
          <div key={m.month} style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 74 }}>
            <div style={{ display: "flex", height: HALF, alignItems: "flex-end" }}>
              <div style={{ display: "flex", width: 46, height: h(m.buys), backgroundColor: BUY, borderRadius: "5px 5px 0 0" }} />
            </div>
            <div style={{ display: "flex", width: 74, height: 2, backgroundColor: "rgba(26,25,21,0.35)" }} />
            <div style={{ display: "flex", height: HALF, alignItems: "flex-start" }}>
              <div style={{ display: "flex", width: 46, height: h(m.sells), backgroundColor: SELL, borderRadius: "0 0 5px 5px" }} />
            </div>
            <div style={{ display: "flex", marginTop: 6, fontSize: 18, color: INK[3] }}>{monthShort(m.month)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function monthShort(key: string): string {
  const [y, m] = key.split("-").map(Number);
  if (!y || !m) return key;
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
}

export default async function Image() {
  let months: MonthlyTrades[] = [];
  try {
    months = await getMonthlyTrades(MONTHS);
  } catch {
    /* the card keeps its headline */
  }
  const buys = months.reduce((n, m) => n + m.buys, 0);
  const sells = months.reduce((n, m) => n + m.sells, 0);
  return renderPageCard({
    title: "Congressional trading by month",
    extra: months.length ? <Columns months={months} /> : undefined,
    stats: months.length
      ? [
          { value: count(buys), label: "purchases, above the line", dot: BUY },
          { value: count(sells), label: "sales, below the line", dot: SELL },
        ]
      : [],
    footnote: "Last 12 months by trade date; the newest are still filling (45-day deadline) · counts, not amounts",
  });
}
