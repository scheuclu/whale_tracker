import { ImageResponse } from "next/og";
import { BRAND_INK, markGlyph } from "@/lib/brand";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

/**
 * Home-screen icon: the paper cat on the ink tile. Full-bleed (radius 0):
 * iOS applies its own rounded mask, and a pre-rounded tile would show the
 * background in the corners.
 *
 * The same drawing as lib/brand.ts, scaled to 80% about the tile centre:
 * at full size the ear tips and cheeks run close to the corner mask, and a
 * home-screen icon reads better with a margin round the glyph.
 */
function appleIconSvg(): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180" viewBox="0 0 32 32">` +
    `<rect width="32" height="32" fill="${BRAND_INK}"/>` +
    markGlyph("translate(16 16.8) scale(0.8) translate(-16 -16.8)") +
    `</svg>`
  );
}

export default function AppleIcon() {
  const src = `data:image/svg+xml;base64,${Buffer.from(appleIconSvg()).toString("base64")}`;
  return new ImageResponse(
    (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={src} width={180} height={180} alt="" />
    ),
    size
  );
}
