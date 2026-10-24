"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Link2, Share2 } from "lucide-react";
import { shareTargets, type ShareNetwork } from "@/lib/share";
import { cn } from "@/lib/utils";

/**
 * One row of share buttons for an entity or view page: the device's own
 * share sheet where there is one, copy link, and plain intent links for X,
 * Bluesky, Reddit and LinkedIn. Every one is a single click. Nothing loads
 * from those sites until the reader picks one, and then only in a new tab:
 * no SDK, no script, no tracker.
 *
 * `url` is the page's canonical absolute URL, built on the server
 * (`absoluteUrl`), so a sorted view or a preview deployment is never what
 * gets shared. `text` is a plain description of the page — the same tone
 * as its title. A disclosed trade is not evidence of wrongdoing
 * (/methodology), and nothing this control writes says otherwise.
 */

/** Brand glyphs on a 24-unit grid, monochrome (simple-icons, CC0). */
const GLYPH: Record<ShareNetwork, string> = {
  x: "M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182z",
  bluesky:
    "M5.202 2.857C7.954 4.922 10.913 9.11 12 11.358c1.087-2.247 4.046-6.436 6.798-8.501C20.783 1.366 24 .213 24 3.883c0 .732-.42 6.156-.667 7.037-.856 3.061-3.978 3.842-6.755 3.37 4.854.826 6.089 3.562 3.422 6.299-5.065 5.196-7.28-1.304-7.847-2.97-.104-.305-.152-.448-.153-.327 0-.121-.05.022-.153.327-.568 1.666-2.782 8.166-7.847 2.97-2.667-2.737-1.432-5.473 3.422-6.3-2.777.473-5.899-.308-6.755-3.369C.42 10.04 0 4.615 0 3.883c0-3.67 3.217-2.517 5.202-1.026",
  reddit:
    "M12 0C5.373 0 0 5.373 0 12c0 3.314 1.343 6.314 3.515 8.485l-2.286 2.286C.775 23.225 1.097 24 1.738 24H12c6.627 0 12-5.373 12-12S18.627 0 12 0Zm4.388 3.199c1.104 0 1.999.895 1.999 1.999 0 1.105-.895 2-1.999 2-.946 0-1.739-.657-1.947-1.539v.002c-1.147.162-2.032 1.15-2.032 2.341v.007c1.776.067 3.4.567 4.686 1.363.473-.363 1.064-.58 1.707-.58 1.547 0 2.802 1.254 2.802 2.802 0 1.117-.655 2.081-1.601 2.531-.088 3.256-3.637 5.876-7.997 5.876-4.361 0-7.905-2.617-7.998-5.87-.954-.447-1.614-1.415-1.614-2.538 0-1.548 1.255-2.802 2.803-2.802.645 0 1.239.218 1.712.585 1.275-.79 2.881-1.291 4.64-1.365v-.01c0-1.663 1.263-3.034 2.88-3.207.188-.911.993-1.595 1.959-1.595Zm-8.085 8.376c-.784 0-1.459.78-1.506 1.797-.047 1.016.64 1.429 1.426 1.429.786 0 1.371-.369 1.418-1.385.047-1.017-.553-1.841-1.338-1.841Zm7.406 0c-.786 0-1.385.824-1.338 1.841.047 1.017.634 1.385 1.418 1.385.785 0 1.473-.413 1.426-1.429-.046-1.017-.721-1.797-1.506-1.797Zm-3.703 4.013c-.974 0-1.907.048-2.77.135-.147.015-.241.168-.183.305.483 1.154 1.622 1.964 2.953 1.964 1.33 0 2.47-.81 2.953-1.964.057-.137-.037-.29-.184-.305-.863-.087-1.795-.135-2.769-.135Z",
  linkedin:
    "M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z",
};

/** The header's icon-button treatment (ThemeToggle in nav.tsx), at a 32px touch target on a phone. */
const ITEM = cn(
  "flex size-8 shrink-0 items-center justify-center rounded-full bg-fill text-foreground",
  "transition-[background-color,color] duration-(--dur) ease-(--ease-out) hover:bg-foreground/[0.1] active:bg-foreground/[0.16]",
  "outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
);

/** For a browser without the async clipboard (or an insecure origin): the old selection copy. */
function legacyCopy(text: string): boolean {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

export function ShareControl({ url, text, className }: { url: string; text: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const [status, setStatus] = useState("");
  // The device's share sheet exists only on some browsers, and only after
  // hydration can we ask: rendering it on the server would mismatch.
  const [canShare, setCanShare] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setCanShare(typeof navigator.share === "function");
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  function announce(message: string, ok: boolean) {
    setCopied(ok);
    setStatus(message);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setCopied(false);
      setStatus("");
    }, 2400);
  }

  async function copy() {
    let ok = false;
    try {
      await navigator.clipboard.writeText(url);
      ok = true;
    } catch {
      ok = legacyCopy(url);
    }
    if (ok) announce("Link copied", true);
    else window.prompt("Copy this link:", url);
  }

  async function nativeShare() {
    try {
      await navigator.share({ title: text, text, url });
    } catch {
      /* dismissed by the reader, or refused: nothing to report */
    }
  }

  return (
    <div role="group" aria-label="Share this page" className={cn("relative flex items-center gap-1.5", className)}>
      <span aria-hidden className="mr-0.5 text-[13px] font-medium text-muted-foreground">
        Share
      </span>
      {canShare ? (
        <button type="button" className={ITEM} onClick={nativeShare} aria-label="Share with another app" title="Share with another app">
          <Share2 className="size-3.5" aria-hidden />
        </button>
      ) : null}
      <button type="button" className={ITEM} onClick={copy} aria-label="Copy link" title="Copy link">
        {copied ? <Check className="size-3.5 text-ok" aria-hidden /> : <Link2 className="size-3.5" aria-hidden />}
      </button>
      {shareTargets(url, text).map((t) => (
        <a
          key={t.network}
          href={t.href}
          target="_blank"
          rel="noopener noreferrer"
          className={ITEM}
          aria-label={`Share on ${t.name} (opens in a new tab)`}
          title={`Share on ${t.name}`}
        >
          <svg viewBox="0 0 24 24" className="size-3.5" fill="currentColor" aria-hidden focusable="false">
            <path d={GLYPH[t.network]} />
          </svg>
        </a>
      ))}
      {/* Always in the DOM so screen readers hear the change; drawn as a
          small popover only while it has something to say. */}
      <span
        role="status"
        aria-live="polite"
        className={cn(
          "pointer-events-none absolute right-0 top-full z-20 mt-1.5 whitespace-nowrap rounded-full bg-popover px-3 py-1 text-[12px] font-medium text-foreground shadow-popover",
          status ? "opacity-100" : "opacity-0"
        )}
      >
        {status}
      </span>
    </div>
  );
}
