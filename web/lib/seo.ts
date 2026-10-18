import type { Metadata } from "next";

import { SITE_NAME } from "./site";

/**
 * One page's metadata: title, description, canonical, and the Open Graph and
 * Twitter copies of both.
 *
 * Next merges metadata shallowly per top-level key, so a page that sets
 * `openGraph` at all replaces the root layout's whole object — site name and
 * type included. Every page goes through here so none of them drops those.
 *
 * `path` is the canonical: the page's own path with only the parameters that
 * define *which* page it is (`?view=late`, `?committee=HSIF`). Sorted,
 * filtered and paged variants pass their base path, so they consolidate on
 * it rather than compete with it. `noindex` keeps a page out of the index
 * while its links are still followed (search results, unknown entities).
 */
export function pageMetadata({
  title,
  description,
  path,
  noindex = false,
  absoluteTitle = false,
  card,
}: {
  title: string;
  description: string;
  path: string;
  noindex?: boolean;
  /** The page's own share card (`entityCard`); the site card otherwise. */
  card?: { og: Card; twitter: Card };
  /** Use `title` as is, without the "· FatCat Watch" template (the home page). */
  absoluteTitle?: boolean;
}): Metadata {
  const shared = absoluteTitle ? title : `${title} · ${SITE_NAME}`;
  return {
    title: absoluteTitle ? { absolute: title } : title,
    description,
    alternates: { canonical: path },
    robots: noindex ? { index: false, follow: true } : undefined,
    // Setting `openGraph` / `twitter` here drops the file-based cards — the
    // root's and the segment's own alike (measured on Next 16.3) — so the
    // card is always named: the entity's when it has one, else the site's.
    openGraph: { type: "website", siteName: SITE_NAME, locale: "en_US", url: path, title: shared, description, images: [card?.og ?? SITE_CARD.og] },
    twitter: { card: "summary_large_image", title: shared, description, images: [card?.twitter ?? SITE_CARD.twitter] },
  };
}

type Card = { url: string; width: number; height: number; type: string; alt: string };

/**
 * An entity segment's own cards (`<path>/opengraph-image`,
 * `<path>/twitter-image`), with the alt text its image files export.
 */
export function entityCard(path: string, alt: string): { og: Card; twitter: Card } {
  const base = path.split("?")[0];
  const card = (file: string) => ({ url: `${base}/${file}`, width: 1200, height: 630, type: "image/png", alt });
  return { og: card("opengraph-image"), twitter: card("twitter-image") };
}

const SITE_CARD_ALT =
  "FatCat Watch — US congressional and corporate-insider stock trades, from STOCK Act and SEC Form 4 filings";

/** The site-wide share card (app/opengraph-image.tsx, app/twitter-image.tsx). */
const SITE_CARD = {
  og: { url: "/opengraph-image", width: 1200, height: 630, type: "image/png", alt: SITE_CARD_ALT },
  twitter: { url: "/twitter-image", width: 1200, height: 630, type: "image/png", alt: SITE_CARD_ALT },
};

/** Trim a description to what a results page shows, on a word boundary. */
export function clip(text: string, max = 160): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), max - 20)).replace(/[\s,;:—-]+$/, "")}…`;
}
