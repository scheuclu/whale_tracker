import { ImageResponse } from "next/og";
import { markDataUri } from "@/lib/brand";
import { CARD_CDN_CACHE_CONTROL } from "@/lib/cache-policy";

/**
 * The share cards for every page but the home page (members, tickers, the
 * section pages, and the query-string views under app/cards/) in the brand
 * look of app/opengraph-image.tsx: the same dark surface, glow and
 * wordmark. Counts only. A congressional total is a range, and a card has
 * no room to say so; a count needs no caveat. Insider cards count too: a
 * value would need "shares × reported price" beside it, and the page says
 * it. Buy and sell use the site's blue↔red pair (the dark-scheme
 * `--viz-buy` / `--viz-sell`) and are always spelled out beside the colour.
 */

export const CARD_SIZE = { width: 1200, height: 630 };

/** Every card response: the CDN holds it (lib/cache-policy.ts). */
export const CARD_HEADERS = { "CDN-Cache-Control": CARD_CDN_CACHE_CONTROL };

/** Ink on the card surface, brightest first. */
export const INK = { 1: "#f2f2f5", 2: "#a3a3b8", 3: "#7a7a90" };

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
            FatCat<span style={{ color: "#9d9dff", marginLeft: 10 }}>Watch</span>
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
    { ...CARD_SIZE, headers: CARD_HEADERS }
  );
}

/** A fallback card when the entity cannot be read: the brand and a name. */
export function renderPlainCard(title: string, subtitle?: string) {
  return renderPageCard({
    title,
    subtitle,
    stats: [],
    footnote: "US congressional and corporate-insider stock trades",
  });
}

/**
 * A section or view card: an eyebrow naming the source, a headline, one
 * line of context, optional extra content (a chart, a row of chips), then
 * the counts. Headline size steps down with length so a long committee
 * name still leaves room for the stats.
 */
export function renderPageCard({
  eyebrow,
  title,
  mono = false,
  subtitle,
  extra,
  stats,
  footnote,
}: {
  eyebrow?: string;
  title: string;
  /** A ticker or filing id: set in mono, like the page's own h1. */
  mono?: boolean;
  subtitle?: string;
  extra?: React.ReactNode;
  stats: CardStat[];
  footnote: string;
}) {
  const t = clipText(title, 90);
  const size = mono ? 112 : t.length > 60 ? 50 : t.length > 34 ? 58 : 68;
  return renderCard({
    body: (
      <div style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 1056 }}>
        {eyebrow ? <div style={{ display: "flex", fontSize: 24, color: "#9d9dff" }}>{eyebrow}</div> : null}
        <div
          style={{
            display: "flex",
            fontSize: size,
            lineHeight: mono ? 1 : 1.08,
            letterSpacing: mono ? "-0.04em" : "-0.035em",
            ...(mono ? { fontFamily: "monospace" } : {}),
          }}
        >
          {t}
        </div>
        {subtitle ? (
          <div style={{ display: "flex", fontSize: 28, lineHeight: 1.35, color: INK[2] }}>{clipText(subtitle, 160)}</div>
        ) : null}
        {extra}
      </div>
    ),
    stats,
    footnote,
  });
}

/** Rounded chips, for a short list of symbols or rules under the headline. */
export function Chips({ items }: { items: string[] }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 6 }}>
      {items.map((s) => (
        <div
          key={s}
          style={{
            display: "flex",
            padding: "6px 16px",
            borderRadius: 999,
            fontSize: 24,
            color: "#d4d4e0",
            border: "1px solid rgba(255,255,255,0.14)",
            backgroundColor: "rgba(255,255,255,0.05)",
          }}
        >
          {s}
        </div>
      ))}
    </div>
  );
}

export function count(n: number): string {
  return n.toLocaleString("en-US");
}

/** "1 trade", "3 trades": the label half of a stat. */
export function noun(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many;
}

/** A date as the cards print it: "Oct 22, 2026". */
export function cardDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(iso.length === 10 ? `${iso}T00:00:00Z` : iso.replace(" ", "T"));
  if (Number.isNaN(t)) return null;
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function clipText(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}
