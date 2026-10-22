/**
 * The FatCat Watch mark: a round, smug cat face (jowly cheeks, half-lidded
 * eyes) in a gold bow tie. Playful, not accusatory: a disclosed trade is not
 * evidence of wrongdoing (/methodology).
 *
 * Two renderings, one drawing:
 *
 * - on the site (`BrandMark`, app/brand.tsx) the cat stands on the page with
 *   no tile — ink on the paper, paper on the ink in dark mode — and only the
 *   tie is coloured;
 * - as an icon or on a share card (`markSvg`) it is a paper cat on an ink
 *   tile, so it holds up on any browser chrome or feed.
 *
 * Drawn on a 32-unit grid so it stays legible at a 16px favicon. The face is
 * one path with the eyes and nose cut out (`fill-rule="evenodd"`), so the
 * surface shows through them in light and dark alike; at 16px what survives
 * is the silhouette (ears, wide cheeks) and a gold bar for the tie. The tie
 * is gold because blue and red are reserved for buy/sell — and gold is the
 * site's one accent.
 *
 * One source for every rendering of it: the header and pages (`BrandMark` in
 * app/brand.tsx), the generated apple-icon and social cards (`markSvg`), and
 * the static app/icon.svg (which cannot import, so lib/brand.test.ts checks
 * it carries these exact paths and colours).
 */
export const FACE_PATH =
  "M6.6 12.4L6.8 2.6L13.2 8C14.8 7.7 17.2 7.7 18.8 8L25.2 2.6L25.4 12.4C28.2 13.8 29.6 16.6 29.2 19.2C28.6 23.2 23.2 25.4 16 25.4C8.8 25.4 3.4 23.2 2.8 19.2C2.4 16.6 3.8 13.8 6.6 12.4Z" +
  "M8.2 15.4H13.6A2.7 2.4 0 0 1 8.2 15.4ZM18.4 15.4H23.8A2.7 2.4 0 0 1 18.4 15.4ZM14.5 19.2H17.5L16 21.1Z";

export const BOW_TIE_PATH =
  "M16 28.3L10.2 31V25.6ZM16 28.3L21.8 25.6V31ZM14.2 28.3a1.8 1.8 0 1 1 3.6 0a1.8 1.8 0 1 1 -3.6 0Z";

/** The tie's gold. Not a data colour: blue and red are buy/sell. */
export const BOW_TIE_FILL = "#fbbf24";

/** The site's ink and paper (globals.css `--foreground` / `--background`, light). */
export const BRAND_INK = "#1a1915";
export const BRAND_PAPER = "#f7f4ed";

/** The face and tie as SVG elements for a 32-unit viewBox, optionally transformed. */
export function markGlyph(transform?: string, face: string = BRAND_PAPER): string {
  const t = transform ? ` transform="${transform}"` : "";
  return (
    `<g${t}><path d="${FACE_PATH}" fill="${face}" fill-rule="evenodd"/>` +
    `<path d="${BOW_TIE_PATH}" fill="${BOW_TIE_FILL}"/></g>`
  );
}

/**
 * The icon: a paper cat on an ink tile, as a standalone SVG document.
 * `radius` is the tile's corner radius in grid units: 6 for a favicon-style
 * tile (the site's corners are nearly square), 0 for a full-bleed square
 * (iOS applies its own mask to the apple-touch-icon).
 */
export function markSvg({ size = 32, radius = 6 }: { size?: number; radius?: number } = {}): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 32 32">` +
    `<rect width="32" height="32" rx="${radius}" fill="${BRAND_INK}"/>` +
    markGlyph() +
    `</svg>`
  );
}

/** `markSvg` as a data URI, for an `<img>` inside `next/og`. */
export function markDataUri(opts?: { size?: number; radius?: number }): string {
  return `data:image/svg+xml;base64,${Buffer.from(markSvg(opts)).toString("base64")}`;
}
