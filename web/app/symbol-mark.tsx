"use client";

import Image from "next/image";
import { useState } from "react";
import { tickerLogoUrl } from "@/lib/format";
import { cn } from "@/lib/utils";

/** The letters set to fill the tile: shorter symbols larger. */
const MARK_TYPE = [
  "text-[40px] sm:text-[50px]",
  "text-[34px] sm:text-[42px]",
  "text-[27px] sm:text-[34px]",
  "text-[22px] sm:text-[27px]",
  "text-[18px] sm:text-[22px]",
];

/**
 * A symbol's mark: its company logo inside a 96px (116px from 640px) iOS
 * app-icon squircle, over the lettered monogram fallback.
 *
 * Like `MemberAvatar` (app/avatar.tsx), the monogram is always rendered and the
 * logo is laid over it (`opacity-0` until `onLoad` confirms decoded pixels):
 * - while loading, or when the symbol has no logo (an obscure fund, an ETF, or
 *   a 404 upstream), the reader sees the neutral lettered squircle with never a
 *   broken-image icon or layout shift;
 * - once loaded, the squircle transitions to an ivory/white icon pad so dark
 *   or navy corporate logos remain legible in dark mode as well as light mode.
 */
export function SymbolMark({ symbol, className }: { symbol: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const src = failed ? null : tickerLogoUrl(symbol);
  const len = symbol.length;
  const type = MARK_TYPE[Math.min(Math.max(len - 2, 0), MARK_TYPE.length - 1)];

  return (
    <span
      aria-hidden
      data-symbol-mark={loaded ? "logo" : "monogram"}
      className={cn(
        "relative inline-flex size-[96px] shrink-0 select-none items-center justify-center overflow-hidden rounded-[26%] transition-colors duration-300 sm:size-[116px]",
        loaded
          ? "bg-white dark:bg-[#f5f5f7]"
          : [
              "bg-[linear-gradient(180deg,color-mix(in_oklab,var(--foreground)_5%,var(--card-solid)),color-mix(in_oklab,var(--foreground)_10%,var(--card-solid)))]",
              "text-[color-mix(in_oklab,var(--foreground)_72%,var(--card-solid))]",
              "dark:bg-[linear-gradient(180deg,color-mix(in_oklab,var(--foreground)_13%,var(--card-solid)),color-mix(in_oklab,var(--foreground)_7%,var(--card-solid)))]",
              "dark:text-[color-mix(in_oklab,var(--foreground)_78%,var(--card-solid))]",
            ],
        "shadow-[0_10px_28px_-6px_rgba(0,0,0,0.12),inset_0_1px_0_rgba(255,255,255,0.75)] dark:shadow-[0_12px_32px_-6px_rgba(0,0,0,0.65),inset_0_1px_0_rgba(255,255,255,0.16)]",
        className
      )}
    >
      <span
        className={cn(
          "figure px-2 font-semibold leading-none tracking-[-0.03em] transition-opacity duration-200 motion-reduce:transition-none",
          type,
          loaded ? "opacity-0" : "opacity-100"
        )}
      >
        {symbol}
      </span>
      {src ? (
        <Image
          src={src}
          alt=""
          width={116}
          height={116}
          loading="eager"
          fetchPriority="high"
          onError={() => setFailed(true)}
          onLoad={(e) => {
            if ((e.currentTarget as HTMLImageElement).naturalWidth) setLoaded(true);
            else setFailed(true);
          }}
          className={cn(
            "absolute inset-0 size-full object-contain p-3.5 transition-opacity duration-300 motion-reduce:transition-none sm:p-4",
            loaded ? "opacity-100" : "opacity-0"
          )}
        />
      ) : null}
      <span className="pointer-events-none absolute inset-0 rounded-[inherit] ring-1 ring-inset ring-black/[0.08] dark:ring-white/[0.14]" />
    </span>
  );
}
