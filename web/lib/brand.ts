/**
 * The Whale Tracker mark: a fluke breaking a wave line, white on the indigo
 * gradient tile. Drawn on a 32-unit grid so it stays legible at a 16px
 * favicon; the fluke is a single path and the sea is a translucent band, so
 * nothing thinner than ~2 units has to survive the downscale.
 *
 * One source for every rendering of it: the header and pages (`WhaleMark` in
 * app/brand.tsx), the generated apple-icon and social cards (`markSvg`), and
 * the static app/icon.svg (which cannot import, so lib/brand.test.ts checks
 * it carries these exact paths).
 */
export const FLUKE_PATH =
  "M16 23.5C15.4 20.9 14.8 19.1 13.7 17.7 10.4 17.1 6.5 14.6 4 7 8.3 8.1 12.4 9.7 16 12.3 19.6 9.7 23.7 8.1 28 7 25.5 14.6 21.6 17.1 18.3 17.7 17.2 19.1 16.6 20.9 16 23.5Z";

export const SEA_PATH = "M0 23.2c2.7-1 5.3-1 8 0s5.3 1 8 0 5.3-1 8 0 5.3 1 8 0V32H0Z";

/** Opacity of the sea band over the tile. */
export const SEA_OPACITY = 0.22;

/** The tile gradient, top-left → bottom-right (same stops as `.brand-mark`). */
export const BRAND_GRADIENT = ["#7c7cf0", "#5b5bd6", "#a855f7"] as const;

/**
 * The full mark as a standalone SVG document. `radius` is the tile's corner
 * radius in grid units: 8 for an app-style tile, 0 for a full-bleed square
 * (iOS applies its own mask to the apple-touch-icon).
 */
export function markSvg({ size = 32, radius = 8 }: { size?: number; radius?: number } = {}): string {
  const [a, b, c] = BRAND_GRADIENT;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 32 32">` +
    `<defs><linearGradient id="t" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="${a}"/><stop offset=".45" stop-color="${b}"/><stop offset="1" stop-color="${c}"/>` +
    `</linearGradient><clipPath id="r"><rect width="32" height="32" rx="${radius}"/></clipPath></defs>` +
    `<g clip-path="url(#r)"><rect width="32" height="32" fill="url(#t)"/>` +
    `<path d="${SEA_PATH}" fill="#fff" opacity="${SEA_OPACITY}"/>` +
    `<path d="${FLUKE_PATH}" fill="#fff"/></g></svg>`
  );
}

/** `markSvg` as a data URI, for an `<img>` inside `next/og`. */
export function markDataUri(opts?: { size?: number; radius?: number }): string {
  return `data:image/svg+xml;base64,${Buffer.from(markSvg(opts)).toString("base64")}`;
}
