import { renderShareCard } from "./opengraph-image";

// The same card as opengraph-image. Config is restated rather than
// re-exported: Next reads these exports statically.
export const alt =
  "Whale Tracker — US congressional and corporate-insider stock trades, from STOCK Act and SEC Form 4 filings";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const revalidate = 3600;

export default function Image() {
  return renderShareCard();
}
