import { BOW_TIE_FILL, BOW_TIE_PATH, FACE_PATH } from "@/lib/brand";
import { cn } from "@/lib/utils";

/**
 * The brand mark: a smug fat-cat face in a gold bow tie, white on the indigo
 * `.brand-mark` tile. Size it with a `size-*` class; the corner radius scales
 * with it (a quarter of the side, as in app/icon.svg).
 */
export function BrandMark({ className, title }: { className?: string; title?: string }) {
  return (
    <span
      className={cn("brand-mark inline-flex size-9 shrink-0 overflow-hidden rounded-[25%]", className)}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <svg viewBox="0 0 32 32" className="size-full" aria-hidden>
        <path d={FACE_PATH} fill="#fff" fillRule="evenodd" />
        <path d={BOW_TIE_PATH} fill={BOW_TIE_FILL} />
      </svg>
    </span>
  );
}

/** Mark + wordmark, as in the header. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("text-[15px] font-semibold leading-tight tracking-[-0.015em] text-foreground", className)}>
      FatCat <span className="font-medium text-muted-foreground">Watch</span>
    </span>
  );
}
