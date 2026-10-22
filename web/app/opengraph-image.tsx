import { ImageResponse } from "next/og";
import { getPipeline } from "@/lib/queries";
import { getInsiderTotals } from "@/lib/insider-queries";
import { CARD_HEADERS, CardMasthead, HAIRLINE, INK, KICKER, PAPER, SERIF, cardFontsOrDefault } from "./share-card";

export const alt =
  "FatCat Watch — US congressional and corporate-insider stock trades, from STOCK Act and SEC Form 4 filings";
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
  // The site's v2 paper (globals.css): ink, an ink rule under the masthead,
  // the serif headline, hairline-separated counts. No gradient, no glow.
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          padding: "48px 72px 52px",
          backgroundColor: PAPER,
          color: INK[1],
          fontFamily: "Inter",
          fontSize: 28,
        }}
      >
        <CardMasthead
          right={
            synced ? <div style={{ display: "flex", fontSize: 21, color: INK[3] }}>Updated {synced}</div> : null
          }
        />

        <div style={{ display: "flex", flexDirection: "column", marginTop: "auto", gap: 16 }}>
          <div
            style={{
              display: "flex",
              fontSize: 21,
              fontWeight: 600,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: KICKER,
            }}
          >
            STOCK Act · SEC Form 4
          </div>
          <div
            style={{
              display: "flex",
              fontFamily: SERIF,
              fontSize: 70,
              lineHeight: 1.05,
              letterSpacing: "-0.015em",
              maxWidth: 1040,
            }}
          >
            What members of Congress and corporate insiders are trading.
          </div>
          <div style={{ display: "flex", fontSize: 26, lineHeight: 1.45, color: INK[2], maxWidth: 1056 }}>
            Disclosures from the House and Senate, and open-market Form 4 trades. Amounts are shown as the ranges
            members file.
          </div>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "flex-end",
            marginTop: 36,
            paddingTop: 24,
            borderTop: `1px solid ${HAIRLINE}`,
          }}
        >
          {stats.length ? (
            stats.map((s, i) => (
              <div
                key={s.label}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  paddingLeft: i ? 36 : 0,
                  paddingRight: 36,
                  borderLeft: i ? `1px solid ${HAIRLINE}` : "none",
                }}
              >
                <div style={{ display: "flex", fontFamily: SERIF, fontSize: 54, lineHeight: 1 }}>{s.value}</div>
                <div style={{ display: "flex", marginTop: 10, fontSize: 21, color: INK[3] }}>{s.label}</div>
              </div>
            ))
          ) : (
            <div style={{ display: "flex", fontSize: 24, color: INK[2] }}>US House · US Senate · SEC EDGAR</div>
          )}
        </div>
      </div>
    ),
    { ...size, headers: CARD_HEADERS, fonts: await cardFontsOrDefault() }
  );
}

export default function Image() {
  return renderShareCard();
}
