import { BOW_TIE_PATH, FACE_PATH } from "@/lib/brand";
import { cn } from "@/lib/utils";

/**
 * The brand mark as the site sets it: the fat cat standing on the page, no
 * tile — ink on the paper, paper on the ink in dark mode (`.brand-mark`,
 * globals.css, sets the colour) — and the tie in the accent gold. The eyes
 * and nose are cut out, so the page shows through them. Size it with a
 * `size-*` class. The tiled variant (an icon, a share card) is
 * `markSvg` in lib/brand.ts.
 */
export function BrandMark({ className, title }: { className?: string; title?: string }) {
  return (
    <span
      className={cn("brand-mark inline-flex size-8 shrink-0", className)}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <svg viewBox="0 0 32 32" className="size-full" aria-hidden>
        <path d={FACE_PATH} fill="currentColor" fillRule="evenodd" />
        <path d={BOW_TIE_PATH} fill="var(--gold)" />
      </svg>
    </span>
  );
}

/** The wordmark: the name in the serif, one weight, ink. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "font-serif text-[21px] font-semibold leading-none tracking-[-0.012em] text-foreground",
        className
      )}
    >
      FatCat Watch
    </span>
  );
}
