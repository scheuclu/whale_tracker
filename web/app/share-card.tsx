import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { markDataUri } from "@/lib/brand";
import { CARD_CDN_CACHE_CONTROL } from "@/lib/cache-policy";

/**
 * The share cards for every page but the home page (members, tickers, the
 * section pages, and the query-string views under app/cards/), in the
 * site's v3 identity: the #f5f5f7 canvas, the app icon (graphite squircle,
 * gold tie), a bold tight headline, counts in a white tile. Counts only. A
 * congressional total is a range, and a card has no room to say so; a
 * count needs no caveat. Insider cards count too: a value would need
 * "shares × reported price" beside it, and the page says it. Buy and sell
 * use the site's Apple blue / orange pair (the light-scheme `--viz-buy` /
 * `--viz-sell`) as a small dot, always beside the count and the word
 * ("12 buys", "30 sells") — the word carries the direction, so the light
 * orange (2.5:1 on this paper) is never read alone.
 */

export const CARD_SIZE = { width: 1200, height: 630 };

/** Every card response: the CDN holds it (lib/cache-policy.ts). */
export const CARD_HEADERS = { "CDN-Cache-Control": CARD_CDN_CACHE_CONTROL };

/** The canvas, the tile and the text greys, brightest-contrast first (globals.css, light). */
export const PAPER = "#f5f5f7";
export const TILE = "#ffffff";
export const INK = { 1: "#1d1d1f", 2: "#424245", 3: "#6e6e73" };
/** The eyebrow's grey (`.kicker`) and the bow tie's gold (lib/brand.ts). */
export const KICKER = "#6e6e73";
export const GOLD = "#fbbf24";
export const HAIRLINE = "rgba(60,60,67,0.16)";

export const BUY = "#007aff";
export const SELL = "#f08a00";

/**
 * The display face for headlines and figures: Inter SemiBold registered
 * under its own family name, so `fontFamily: DISPLAY` is the bold voice and
 * the default family stays Inter at 400. (SF Pro cannot be embedded.)
 */
export const DISPLAY = "Inter Display";

/**
 * The card fonts, read once per server instance. Static TTF instances
 * (satori reads neither woff2 nor variable fonts) of the families next/font
 * serves the site, OFL-licensed (assets/fonts/OFL-*.txt). Traced into the
 * card functions by `outputFileTracingIncludes` in next.config.ts.
 */
let fonts: Promise<{ name: string; data: Buffer; weight: 400 | 500 | 600; style: "normal" }[]> | null = null;
export function cardFonts() {
  if (!fonts) {
    const dir = join(process.cwd(), "assets", "fonts");
    fonts = Promise.all([
      readFile(join(dir, "Inter-Regular.ttf")),
      readFile(join(dir, "Inter-SemiBold.ttf")),
    ]).then(([regular, semibold]) => [
      { name: "Inter", data: regular, weight: 400 as const, style: "normal" as const },
      { name: "Inter", data: semibold, weight: 600 as const, style: "normal" as const },
      { name: DISPLAY, data: semibold, weight: 600 as const, style: "normal" as const },
    ]);
    // A missing file must not poison every later render: try again next time.
    fonts.catch(() => {
      fonts = null;
    });
  }
  return fonts;
}

/** Fonts for `ImageResponse`, or none (satori's default face) if they cannot be read. */
export async function cardFontsOrDefault() {
  try {
    return await cardFonts();
  } catch {
    return undefined;
  }
}

export type CardStat = { value: string; label: string; dot?: string };

export function Stat({ value, label, dot, first }: CardStat & { first?: boolean }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        paddingLeft: first ? 0 : 36,
        paddingRight: 36,
        borderLeft: first ? "none" : `1px solid ${HAIRLINE}`,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 21, color: INK[3] }}>
        {dot ? <div style={{ display: "flex", width: 12, height: 12, borderRadius: 6, backgroundColor: dot }} /> : null}
        {label}
      </div>
      <div style={{ display: "flex", marginTop: 8, fontFamily: DISPLAY, fontSize: 54, lineHeight: 1, letterSpacing: "-0.03em", color: INK[1] }}>{value}</div>
    </div>
  );
}

/** The card's masthead: the app icon and the name. */
export function CardMasthead({ right }: { right?: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={markDataUri({ size: 56 })} width={56} height={56} alt="" />
        <div style={{ display: "flex", fontFamily: DISPLAY, fontSize: 34, letterSpacing: "-0.025em", color: INK[1] }}>
          FatCat Watch
        </div>
      </div>
      {right}
    </div>
  );
}

export async function renderCard({
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
          padding: "48px 72px 52px",
          backgroundColor: PAPER,
          color: INK[1],
          fontFamily: "Inter",
          fontSize: 28,
        }}
      >
        <CardMasthead />

        {body}

        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          {stats.length ? (
            <div style={{ display: "flex", padding: "26px 32px", borderRadius: 28, backgroundColor: TILE }}>
              {stats.map((s, i) => (
                <Stat key={s.label} {...s} first={i === 0} />
              ))}
            </div>
          ) : null}
          <div style={{ display: "flex", fontSize: 20, color: INK[3] }}>{footnote}</div>
        </div>
      </div>
    ),
    { ...CARD_SIZE, headers: CARD_HEADERS, fonts: await cardFontsOrDefault() }
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
 * A section or view card: a kicker naming the source, a serif headline, one
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
  /** A ticker or filing id: set larger and tighter, like the page's own h1. */
  mono?: boolean;
  subtitle?: string;
  extra?: React.ReactNode;
  stats: CardStat[];
  footnote: string;
}) {
  const t = clipText(title, 90);
  const size = mono ? 112 : t.length > 60 ? 54 : t.length > 34 ? 62 : 74;
  return renderCard({
    body: (
      <div style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 1056 }}>
        {eyebrow ? (
          <div
            style={{
              display: "flex",
              fontSize: 21,
              fontWeight: 600,
              color: KICKER,
            }}
          >
            {eyebrow}
          </div>
        ) : null}
        <div
          style={{
            display: "flex",
            fontFamily: DISPLAY,
            fontSize: size,
            lineHeight: mono ? 1 : 1.06,
            letterSpacing: "-0.03em",
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

/** Hairline chips, for a short list of symbols or rules under the headline. */
export function Chips({ items }: { items: string[] }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 6 }}>
      {items.map((s) => (
        <div
          key={s}
          style={{
            display: "flex",
            padding: "5px 14px",
            borderRadius: 999,
            fontSize: 24,
            fontWeight: 600,
            color: INK[1],
            backgroundColor: "rgba(118,118,128,0.12)",
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
