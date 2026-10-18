import { FLUKE_PATH, SEA_OPACITY, SEA_PATH } from "@/lib/brand";
import { cn } from "@/lib/utils";

/**
 * The brand mark: a whale fluke breaking the surface, white on the indigo
 * `.brand-mark` tile. Size it with a `size-*` class; the corner radius scales
 * with it (a quarter of the side, as in app/icon.svg).
 */
export function WhaleMark({ className, title }: { className?: string; title?: string }) {
  return (
    <span
      className={cn("brand-mark inline-flex size-9 shrink-0 overflow-hidden rounded-[25%]", className)}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <svg viewBox="0 0 32 32" className="size-full" aria-hidden>
        <path d={SEA_PATH} fill="#fff" opacity={SEA_OPACITY} />
        <path d={FLUKE_PATH} fill="#fff" />
      </svg>
    </span>
  );
}

/** Mark + wordmark, as in the header. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("text-[15px] font-semibold leading-tight tracking-[-0.015em] text-foreground", className)}>
      Whale <span className="font-medium text-muted-foreground">Tracker</span>
    </span>
  );
}
