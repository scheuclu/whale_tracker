import { ImageResponse } from "next/og";
import { markDataUri } from "@/lib/brand";

/**
 * The entity share cards (`/members/<slug>`, `/tickers/<SYMBOL>`) in the
 * brand look of app/opengraph-image.tsx: the same dark surface, glow and
 * wordmark. Counts only. A congressional total is a range, and a card has
 * no room to say so; a count needs no caveat. Buy and sell use the site's
 * blue↔red pair (the dark-scheme `--viz-buy` / `--viz-sell`) and are always
 * spelled out beside the colour.
 */

export const CARD_SIZE = { width: 1200, height: 630 };

export const BUY = "#3987e5";
export const SELL = "#e66767";

export type CardStat = { value: string; label: string; dot?: string };

export function Stat({ value, label, dot }: CardStat) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        padding: "16px 24px",
        borderRadius: 22,
        border: "1px solid rgba(255,255,255,0.1)",
        backgroundColor: "rgba(255,255,255,0.045)",
      }}
    >
      <div style={{ display: "flex", fontSize: 44, letterSpacing: "-0.03em" }}>{value}</div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 21, color: "#9595a8" }}>
        {dot ? <div style={{ display: "flex", width: 12, height: 12, borderRadius: 6, backgroundColor: dot }} /> : null}
        {label}
      </div>
    </div>
  );
}

export function renderCard({
  body,
  stats,
  footnote,
}: {
  body: React.ReactNode;
  stats: CardStat[];
  footnote: string;
}) {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "56px 72px",
          backgroundColor: "#08080c",
          backgroundImage:
            "radial-gradient(900px 560px at 8% -18%, rgba(124,124,240,0.34), transparent 62%), radial-gradient(700px 480px at 100% 0%, rgba(56,189,248,0.14), transparent 60%), radial-gradient(800px 600px at 70% 120%, rgba(168,85,247,0.2), transparent 62%)",
          color: "#f2f2f5",
          fontSize: 28,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={markDataUri({ size: 56 })} width={56} height={56} alt="" />
          <div style={{ display: "flex", fontSize: 32, letterSpacing: "-0.02em" }}>
            Whale<span style={{ color: "#9d9dff", marginLeft: 10 }}>Tracker</span>
          </div>
        </div>

        {body}

        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <div style={{ display: "flex", gap: 16 }}>
            {stats.map((s) => (
              <Stat key={s.label} {...s} />
            ))}
          </div>
          <div style={{ display: "flex", fontSize: 20, color: "#7a7a90" }}>{footnote}</div>
        </div>
      </div>
    ),
    CARD_SIZE
  );
}

/** A fallback card when the entity cannot be read: the brand and a name. */
export function renderPlainCard(title: string) {
  return renderCard({
    body: <div style={{ display: "flex", fontSize: 72, letterSpacing: "-0.035em" }}>{title}</div>,
    stats: [],
    footnote: "US congressional and corporate-insider stock trades",
  });
}

export function count(n: number): string {
  return n.toLocaleString("en-US");
}
