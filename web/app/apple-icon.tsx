import { ImageResponse } from "next/og";
import { BRAND_GRADIENT, FLUKE_PATH, SEA_OPACITY, SEA_PATH } from "@/lib/brand";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

/**
 * Home-screen icon. Full-bleed (radius 0): iOS applies its own rounded mask,
 * and a pre-rounded tile would show the background in the corners.
 *
 * The same drawing as lib/brand.ts, with the fluke scaled to 84% about the
 * tile centre: at full size its tips run into the corner mask, and a
 * home-screen icon reads better with a margin round the glyph.
 */
function appleIconSvg(): string {
  const [a, b, c] = BRAND_GRADIENT;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180" viewBox="0 0 32 32">` +
    `<defs><linearGradient id="t" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="${a}"/><stop offset=".45" stop-color="${b}"/><stop offset="1" stop-color="${c}"/>` +
    `</linearGradient></defs>` +
    `<rect width="32" height="32" fill="url(#t)"/>` +
    `<path d="${SEA_PATH}" fill="#fff" opacity="${SEA_OPACITY}"/>` +
    `<path d="${FLUKE_PATH}" fill="#fff" transform="translate(16 15.5) scale(0.84) translate(-16 -15.5)"/>` +
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
