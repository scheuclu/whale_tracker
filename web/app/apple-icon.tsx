import { ImageResponse } from "next/og";
import { markDataUri } from "@/lib/brand";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

/**
 * Home-screen icon. Full-bleed (radius 0): iOS applies its own rounded mask,
 * and a pre-rounded tile would show the background in the corners.
 */
export default function AppleIcon() {
  return new ImageResponse(
    (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={markDataUri({ size: 180, radius: 0 })} width={180} height={180} alt="" />
    ),
    size
  );
}
