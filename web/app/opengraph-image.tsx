import { ImageResponse } from "next/og";
import { markDataUri } from "@/lib/brand";
import { getPipeline } from "@/lib/queries";
import { getInsiderTotals } from "@/lib/insider-queries";

export const alt =
  "Whale Tracker — US congressional and corporate-insider stock trades, from STOCK Act and SEC Form 4 filings";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
// Live counts, re-rendered at most hourly: link previews are cached by the
// sites that fetch them anyway, and the pipeline itself runs every few hours.
export const revalidate = 3600;

type Headline = { value: string; label: string };

/**
 * Counts only — never an amount. A congressional total is a range, and a
 * share card has no room to say so; a count needs no caveat.
 */
async function headlines(): Promise<{ stats: Headline[]; synced: string | null }> {
  const stats: Headline[] = [];
  let synced: string | null = null;
  try {
    const p = await getPipeline();
    stats.push(
      { value: p.totals.transactions.toLocaleString("en-US"), label: "congressional trades" },
      { value: p.totals.members.toLocaleString("en-US"), label: "members trading" }
    );
    const t = p.lastUpdated ? Date.parse(p.lastUpdated.replace(" ", "T")) : NaN;
    if (!Number.isNaN(t)) {
      synced = new Date(t).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      });
    }
  } catch {
    /* no database at render time: the card falls back to the static copy */
  }
  try {
    const trades = (await getInsiderTotals()).trades;
    if (trades) stats.push({ value: trades.toLocaleString("en-US"), label: "insider trades" });
  } catch {
    /* a database from before the insider source */
  }
  return { stats, synced };
}

export async function renderShareCard() {
  const { stats, synced } = await headlines();
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "64px 72px",
          backgroundColor: "#08080c",
          backgroundImage:
            "radial-gradient(900px 560px at 8% -18%, rgba(124,124,240,0.34), transparent 62%), radial-gradient(700px 480px at 100% 0%, rgba(56,189,248,0.14), transparent 60%), radial-gradient(800px 600px at 70% 120%, rgba(168,85,247,0.2), transparent 62%)",
          color: "#f2f2f5",
          fontSize: 28,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 22 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={markDataUri({ size: 76 })} width={76} height={76} alt="" />
          <div style={{ display: "flex", fontSize: 40, letterSpacing: "-0.02em" }}>
            Whale<span style={{ color: "#9d9dff", marginLeft: 12 }}>Tracker</span>
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <div style={{ display: "flex", fontSize: 66, lineHeight: 1.08, letterSpacing: "-0.035em", maxWidth: 980 }}>
            What members of Congress and corporate insiders are trading.
          </div>
          <div style={{ display: "flex", fontSize: 28, lineHeight: 1.4, color: "#a3a3b8", maxWidth: 960 }}>
            STOCK Act disclosures from the House and Senate, and SEC Form 4 open-market trades. Amounts
            are shown as the ranges members file.
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between" }}>
          {stats.length ? (
            <div style={{ display: "flex", gap: 18 }}>
              {stats.map((s) => (
                <div
                  key={s.label}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    padding: "18px 26px",
                    borderRadius: 22,
                    border: "1px solid rgba(255,255,255,0.1)",
                    backgroundColor: "rgba(255,255,255,0.045)",
                  }}
                >
                  <div style={{ display: "flex", fontSize: 46, letterSpacing: "-0.03em" }}>{s.value}</div>
                  <div style={{ display: "flex", fontSize: 22, color: "#9595a8" }}>{s.label}</div>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ display: "flex", fontSize: 26, color: "#9595a8" }}>
              US House · US Senate · SEC EDGAR
            </div>
          )}
          {synced ? (
            <div style={{ display: "flex", fontSize: 22, color: "#7a7a90" }}>synced {synced}</div>
          ) : null}
        </div>
      </div>
    ),
    size
  );
}

export default function Image() {
  return renderShareCard();
}
