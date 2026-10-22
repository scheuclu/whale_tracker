import { ImageResponse } from "next/og";
import { markSvg } from "@/lib/brand";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

/**
 * Home-screen icon: the white cat on the graphite tile, gold tie. Full
 * bleed (a square): iOS applies its own squircle mask, and a pre-cut tile
 * would show the background in the corners. The same drawing as
 * lib/brand.ts and app/icon.svg.
 */
export default function AppleIcon() {
  const src = `data:image/svg+xml;base64,${Buffer.from(markSvg({ size: 180, shape: "square" })).toString("base64")}`;
  return new ImageResponse(
    (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={src} width={180} height={180} alt="" />
    ),
    size
  );
}
