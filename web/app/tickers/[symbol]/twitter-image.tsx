import Image from "./opengraph-image";

// The same card as opengraph-image; without this file the root
// twitter-image would be inherited and every ticker would share the site
// card on X. Config is restated rather than re-exported: Next reads these
// exports statically.
export const alt = "A ticker's congressional trades on Whale Tracker: members trading and buy/sell counts";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const revalidate = 3600;

export default Image;
