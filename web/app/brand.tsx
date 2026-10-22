import { useId } from "react";
import { BOW_TIE_PATH, FACE_PATH } from "@/lib/brand";
import { cn } from "@/lib/utils";

/**
 * The brand mark as the site sets it: a monochrome glyph in the ink of the
 * page (`.brand-mark`, globals.css), like the apple in Apple's own nav. The
 * tie is the same ink; a hairline of whatever is behind the mark is cut out
 * of the face round the tie (a mask, so it works on the frosted nav and on
 * a tile alike) so chin and tie stay two shapes. The eyes and nose are cut
 * out too. Size it with a `size-*` class. The coloured app icon (graphite
 * squircle, gold tie) is `markSvg` in lib/brand.ts.
 */
export function BrandMark({ className, title }: { className?: string; title?: string }) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const mask = `brand-gap-${id}`;
  return (
    <span
      className={cn("brand-mark inline-flex size-8 shrink-0", className)}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <svg viewBox="0 0 32 32" className="size-full" aria-hidden>
        <defs>
          <mask id={mask} maskUnits="userSpaceOnUse" x="0" y="0" width="32" height="32">
            <rect width="32" height="32" fill="#fff" />
            <path d={BOW_TIE_PATH} fill="#000" stroke="#000" strokeWidth="2.2" strokeLinejoin="round" />
          </mask>
        </defs>
        <path d={FACE_PATH} fill="currentColor" fillRule="evenodd" mask={`url(#${mask})`} />
        <path d={BOW_TIE_PATH} fill="currentColor" />
      </svg>
    </span>
  );
}

/** The wordmark: the name in the display face, semibold and tight, ink. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "font-display text-[19px] font-semibold leading-none tracking-[-0.022em] text-foreground",
        className
      )}
    >
      FatCat Watch
    </span>
  );
}
