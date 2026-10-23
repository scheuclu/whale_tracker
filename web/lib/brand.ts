/**
 * The FatCat Watch mark: a round, smug cat face (jowly cheeks, half-lidded
 * eyes) in a bow tie. Playful, not accusatory: a disclosed trade is not
 * evidence of wrongdoing (/methodology).
 *
 * Two renderings, one drawing — the way Apple sets its own marks:
 *
 * - on the site (`BrandMark`, app/brand.tsx) a monochrome glyph in the ink
 *   of the page (graphite on light, white on dark), tie included, with a
 *   hairline of the page cut between chin and tie so the two stay apart;
 * - as an app icon (favicon, home-screen icon, share cards: `markSvg`) a
 *   white cat on a graphite squircle with a soft top-lit gradient, like an
 *   iOS icon, and the tie in gold — the one place colour belongs to the
 *   brand rather than the data.
 *
 * Drawn on a 32-unit grid so it stays legible at a 16px favicon. The face is
 * one path with the eyes and nose cut out (`fill-rule="evenodd"`), so the
 * surface shows through them; at 16px what survives is the silhouette
 * (ears, wide cheeks) and a gold bar for the tie. The tie is gold, never
 * blue or red: those are buy and sell.
 *
 * One source for every rendering: the header and pages (`BrandMark`), the
 * generated apple-icon and social cards (`markSvg`), and the static
 * app/icon.svg (which cannot import, so lib/brand.test.ts checks it is
 * byte-for-byte `markSvg()`).
 */
export const FACE_PATH =
  "M6.6 12.4L6.8 2.6L13.2 8C14.8 7.7 17.2 7.7 18.8 8L25.2 2.6L25.4 12.4C28.2 13.8 29.6 16.6 29.2 19.2C28.6 23.2 23.2 25.4 16 25.4C8.8 25.4 3.4 23.2 2.8 19.2C2.4 16.6 3.8 13.8 6.6 12.4Z" +
  "M8.2 15.4H13.6A2.7 2.4 0 0 1 8.2 15.4ZM18.4 15.4H23.8A2.7 2.4 0 0 1 18.4 15.4ZM14.5 19.2H17.5L16 21.1Z";

export const BOW_TIE_PATH =
  "M16 28.3L10.2 31V25.6ZM16 28.3L21.8 25.6V31ZM14.2 28.3a1.8 1.8 0 1 1 3.6 0a1.8 1.8 0 1 1 -3.6 0Z";

/**
 * The app-icon tile: a superellipse (n = 5) on the 32-unit grid — the
 * continuous-curvature "squircle" of an iOS icon, not a rounded rectangle.
 */
export const SQUIRCLE_PATH =
  "M32 16 31.98 22.03 31.9 23.94 31.78 25.32 31.61 26.42 31.38 27.34 31.11 28.13 30.77 28.81 30.38 29.41 29.93 29.93 29.41 30.38 28.81 30.77 28.13 31.11 27.34 31.38 26.42 31.61 25.32 31.78 23.94 31.9 22.03 31.98 16 32 9.97 31.98 8.06 31.9 6.68 31.78 5.58 31.61 4.66 31.38 3.87 31.11 3.19 30.77 2.59 30.38 2.07 29.93 1.62 29.41 1.23 28.81 0.89 28.13 0.62 27.34 0.39 26.42 0.22 25.32 0.1 23.94 0.02 22.03 0 16 0.02 9.97 0.1 8.06 0.22 6.68 0.39 5.58 0.62 4.66 0.89 3.87 1.23 3.19 1.62 2.59 2.07 2.07 2.59 1.62 3.19 1.23 3.87 0.89 4.66 0.62 5.58 0.39 6.68 0.22 8.06 0.1 9.97 0.02 16 0 22.03 0.02 23.94 0.1 25.32 0.22 26.42 0.39 27.34 0.62 28.13 0.89 28.81 1.23 29.41 1.62 29.93 2.07 30.38 2.59 30.77 3.19 31.11 3.87 31.38 4.66 31.61 5.58 31.78 6.68 31.9 8.06 31.98 9.97Z";

/** The tie's gold: brand, not data — the one colour the page keeps for itself. */
export const BOW_TIE_FILL = "#fbbf24";

/** The site's ink (globals.css `--foreground`, light) and the icon's cat. */
export const BRAND_INK = "#1d1d1f";
export const BRAND_PAPER = "#ffffff";

/** The icon tile's top-lit graphite: light at the top, ink at the foot. */
export const TILE_TOP = "#4a4a4e";
export const TILE_BOTTOM = BRAND_INK;

/** The face and tie as SVG elements for a 32-unit viewBox, optionally transformed. */
export function markGlyph(transform?: string, face: string = BRAND_PAPER): string {
  const t = transform ? ` transform="${transform}"` : "";
  return (
    `<g${t}><path d="${FACE_PATH}" fill="${face}" fill-rule="evenodd"/>` +
    `<path d="${BOW_TIE_PATH}" fill="${BOW_TIE_FILL}"/></g>`
  );
}

/**
 * The glyph sits at 78% of a home-screen tile, centred a touch low (the
 * ears are taller than the tie is deep), so it has the margin an iOS icon
 * has; at 84% on the favicon squircle, where every pixel of a 16px tab
 * icon counts and the squircle already rounds the corners away.
 */
export const ICON_GLYPH_TRANSFORM = "translate(16 16.6) scale(0.78) translate(-16 -16.6)";
export const FAVICON_GLYPH_TRANSFORM = "translate(16 16.4) scale(0.84) translate(-16 -16.4)";

/**
 * The app icon as a standalone SVG document: the white cat on the graphite
 * squircle. `shape: "square"` is full bleed, for the apple-touch-icon —
 * iOS applies its own mask, and a pre-cut squircle would show the
 * background in the corners.
 */
export function markSvg({ size = 32, shape = "squircle" }: { size?: number; shape?: "squircle" | "square" } = {}): string {
  const tile = shape === "square" ? `<rect width="32" height="32" fill="url(#t)"/>` : `<path d="${SQUIRCLE_PATH}" fill="url(#t)"/>`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 32 32">` +
    `<defs><linearGradient id="t" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="${TILE_TOP}"/><stop offset="1" stop-color="${TILE_BOTTOM}"/>` +
    `</linearGradient></defs>` +
    tile +
    markGlyph(shape === "square" ? ICON_GLYPH_TRANSFORM : FAVICON_GLYPH_TRANSFORM) +
    `</svg>`
  );
}

/** `markSvg` as a data URI, for an `<img>` inside `next/og`. */
export function markDataUri(opts?: { size?: number; shape?: "squircle" | "square" }): string {
  return `data:image/svg+xml;base64,${Buffer.from(markSvg(opts)).toString("base64")}`;
}
