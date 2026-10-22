/**
 * Share links for the share control (app/share-control.tsx). Plain intent
 * URLs only: no SDK, no script, nothing loads from a third party until the
 * reader clicks one, and then only in a new tab.
 *
 * `url` is always the canonical absolute URL (`absoluteUrl(path)`, built on
 * the server), never `location.href`: a preview deployment, a sorted view or
 * a tracking parameter must not be what gets shared.
 */

export type ShareNetwork = "x" | "bluesky" | "reddit" | "linkedin";

export type ShareTarget = { network: ShareNetwork; name: string; href: string };

export function shareTargets(url: string, text: string): ShareTarget[] {
  const u = encodeURIComponent(url);
  const t = encodeURIComponent(text);
  return [
    // https://developer.x.com/en/docs/x-for-websites/tweet-button/guides/web-intent
    { network: "x", name: "X", href: `https://x.com/intent/tweet?text=${t}&url=${u}` },
    // https://docs.bsky.app/docs/advanced-guides/intent-links — text only; the
    // link card is built from the URL inside it.
    { network: "bluesky", name: "Bluesky", href: `https://bsky.app/intent/compose?text=${encodeURIComponent(`${text} ${url}`)}` },
    { network: "reddit", name: "Reddit", href: `https://www.reddit.com/submit?url=${u}&title=${t}` },
    // LinkedIn reads everything else from the page's Open Graph tags.
    { network: "linkedin", name: "LinkedIn", href: `https://www.linkedin.com/sharing/share-offsite/?url=${u}` },
  ];
}
