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
  // The dashboard's dark surfaces (globals.css): page, card hairline, three ink levels.
  const ink = { 1: "#ededf0", 2: "#b9bcc6", 3: "#8d919d" };
  const hairline = "rgba(255,255,255,0.09)";
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          padding: "60px 72px 56px",
          backgroundColor: "#0b0c0f",
          // One quiet indigo wash from the mark's corner; the rest is the flat page.
          backgroundImage:
            "radial-gradient(820px 520px at 0% 0%, rgba(139,139,242,0.20), transparent 62%), radial-gradient(640px 420px at 100% 100%, rgba(139,139,242,0.07), transparent 60%)",
          color: ink[1],
          fontSize: 28,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={markDataUri({ size: 60 })} width={60} height={60} alt="" />
            <div style={{ display: "flex", fontSize: 34, letterSpacing: "-0.01em" }}>
              Whale<span style={{ color: "#a5a5f6", marginLeft: 10 }}>Tracker</span>
            </div>
          </div>
          {synced ? (
            <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 21, color: ink[3] }}>
              <div style={{ display: "flex", width: 9, height: 9, borderRadius: 9, backgroundColor: "#55b685" }} />
              synced {synced}
            </div>
          ) : null}
        </div>

        <div style={{ display: "flex", flexDirection: "column", marginTop: "auto", gap: 18 }}>
          <div style={{ display: "flex", fontSize: 62, lineHeight: 1.1, letterSpacing: "-0.02em", maxWidth: 1000 }}>
            What members of Congress and corporate insiders are trading.
          </div>
          <div style={{ display: "flex", fontSize: 26, lineHeight: 1.45, color: ink[3], maxWidth: 960 }}>
            STOCK Act disclosures from the House and Senate, and SEC Form 4 open-market trades. Amounts
            are shown as the ranges members file.
          </div>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "flex-end",
            marginTop: 40,
            paddingTop: 28,
            borderTop: `1px solid ${hairline}`,
          }}
        >
          {stats.length ? (
            stats.map((s, i) => (
              <div
                key={s.label}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  paddingLeft: i ? 40 : 0,
                  paddingRight: 40,
                  borderLeft: i ? `1px solid ${hairline}` : "none",
                }}
              >
                <div style={{ display: "flex", fontSize: 50, lineHeight: 1, letterSpacing: "-0.025em" }}>{s.value}</div>
                <div style={{ display: "flex", marginTop: 10, fontSize: 21, color: ink[3] }}>{s.label}</div>
              </div>
            ))
          ) : (
            <div style={{ display: "flex", fontSize: 24, color: ink[2] }}>US House · US Senate · SEC EDGAR</div>
          )}
        </div>
      </div>
    ),
    size
  );
}

export default function Image() {
  return renderShareCard();
}
