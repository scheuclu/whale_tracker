"use client";

import Image from "next/image";
import { useState } from "react";
import { tickerLogoUrl } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Rendered edge in CSS pixels, matching `MemberAvatar` (app/avatar.tsx):
 * xs 20 · sm 24 (table and list rows) · md 32 (ranked bar cards, search
 * results) · lg 40 · xl 96/116 (the ticker / issuer hero).
 */
const PX = { xs: 20, sm: 24, md: 32, lg: 40, xl: 116 } as const;

export type SymbolMarkSize = keyof typeof PX;

/** Hero monogram type (`size="xl"`): shorter symbols larger. */
const HERO_MARK_TYPE = [
  "text-[40px] sm:text-[50px]",
  "text-[34px] sm:text-[42px]",
  "text-[27px] sm:text-[34px]",
  "text-[22px] sm:text-[27px]",
  "text-[18px] sm:text-[22px]",
];

/** Compact monogram type (`xs`–`lg`). */
const COMPACT_MARK_TYPE: Record<Exclude<SymbolMarkSize, "xl">, string> = {
  xs: "text-[7px] tracking-[-0.02em]",
  sm: "text-[8px] tracking-[-0.02em]",
  md: "text-[10px] tracking-[-0.02em]",
  lg: "text-[12px] tracking-[-0.02em]",
};

/** Logo inset padding per size so the corporate mark breathes inside the squircle. */
const LOGO_PAD: Record<SymbolMarkSize, string> = {
  xs: "p-[2.5px]",
  sm: "p-[3px]",
  md: "p-1",
  lg: "p-1.5",
  xl: "p-3.5 sm:p-4",
};

/**
 * Detect whether a decoded logo is a monochrome white-on-transparent glyph
 * (e.g. FMP's `BA.png` for Boeing, which is pure `#ffffff` on `alpha = 0` and
 * would otherwise vanish against the white icon pad). Because `next/image`
 * proxies logos from `'self'`, a tiny offscreen canvas read never taints CORS.
 */
function isWhiteOnTransparent(img: HTMLImageElement): boolean {
  try {
    const size = 24;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return false;
    ctx.drawImage(img, 0, 0, size, size);
    const { data } = ctx.getImageData(0, 0, size, size);
    let opaque = 0;
    let nearWhite = 0;
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3];
      if (a < 48) continue;
      opaque++;
      const lum = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      if (lum > 225) nearWhite++;
    }
    return opaque > 0 && opaque < size * size * 0.9 && nearWhite / opaque > 0.92;
  } catch {
    return false;
  }
}

/**
 * A symbol's mark: its company logo inside an iOS app-icon squircle, over the
 * lettered monogram fallback.
 *
 * Like `MemberAvatar` (app/avatar.tsx), the monogram is always rendered and the
 * logo is laid over it (`opacity-0` until `onLoad` confirms decoded pixels):
 * - while loading, or when the symbol has no logo (an obscure fund, an ETF, or
 *   a 404 upstream), the reader sees the neutral lettered squircle with never a
 *   broken-image icon or layout shift;
 * - once loaded, the squircle transitions to an ivory/white icon pad so dark
 *   or navy corporate logos remain legible in dark mode as well as light mode.
 */
export function SymbolMark({
  symbol,
  size = "xl",
  className,
}: {
  symbol: string;
  size?: SymbolMarkSize;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [whiteGlyph, setWhiteGlyph] = useState(false);
  const src = failed ? null : tickerLogoUrl(symbol);
  const px = PX[size];
  const xl = size === "xl";
  const len = symbol.length;
  const heroType = HERO_MARK_TYPE[Math.min(Math.max(len - 2, 0), HERO_MARK_TYPE.length - 1)];
  const monogram = xl ? symbol : symbol.slice(0, 3);

  return (
    <span
      aria-hidden
      data-symbol-mark={loaded ? "logo" : "monogram"}
      className={cn(
        "relative inline-flex shrink-0 select-none items-center justify-center overflow-hidden rounded-[26%] transition-colors duration-300",
        xl ? "size-[96px] sm:size-[116px]" : COMPACT_MARK_TYPE[size],
        loaded
          ? "bg-white dark:bg-[#f5f5f7]"
          : xl
            ? [
                "bg-[linear-gradient(180deg,color-mix(in_oklab,var(--foreground)_5%,var(--card-solid)),color-mix(in_oklab,var(--foreground)_10%,var(--card-solid)))]",
                "text-[color-mix(in_oklab,var(--foreground)_72%,var(--card-solid))]",
                "dark:bg-[linear-gradient(180deg,color-mix(in_oklab,var(--foreground)_13%,var(--card-solid)),color-mix(in_oklab,var(--foreground)_7%,var(--card-solid)))]",
                "dark:text-[color-mix(in_oklab,var(--foreground)_78%,var(--card-solid))]",
              ]
            : [
                "bg-[color-mix(in_oklab,var(--foreground)_6%,var(--card-solid))] text-[color-mix(in_oklab,var(--foreground)_58%,var(--card-solid))]",
                "dark:bg-[color-mix(in_oklab,var(--foreground)_9%,var(--card-solid))] dark:text-[color-mix(in_oklab,var(--foreground)_66%,var(--card-solid))]",
              ],
        xl &&
          "shadow-[0_10px_28px_-6px_rgba(0,0,0,0.12),inset_0_1px_0_rgba(255,255,255,0.75)] dark:shadow-[0_12px_32px_-6px_rgba(0,0,0,0.65),inset_0_1px_0_rgba(255,255,255,0.16)]",
        className
      )}
      style={xl ? undefined : { width: px, height: px }}
    >
      <span
        className={cn(
          "figure font-semibold leading-none transition-opacity duration-200 motion-reduce:transition-none",
          xl ? cn("px-2 tracking-[-0.03em]", heroType) : "px-0.5",
          loaded ? "opacity-0" : "opacity-100"
        )}
      >
        {monogram}
      </span>
      {src ? (
        <Image
          src={src}
          alt=""
          width={px}
          height={px}
          loading={xl ? "eager" : "lazy"}
          fetchPriority={xl ? "high" : undefined}
          onError={() => setFailed(true)}
          onLoad={(e) => {
            const img = e.currentTarget as HTMLImageElement;
            if (img.naturalWidth) {
              setWhiteGlyph(isWhiteOnTransparent(img));
              setLoaded(true);
            } else {
              setFailed(true);
            }
          }}
          className={cn(
            "absolute inset-0 size-full object-contain transition-opacity duration-300 motion-reduce:transition-none",
            LOGO_PAD[size],
            whiteGlyph && "brightness-[0.14]",
            loaded ? "opacity-100" : "opacity-0"
          )}
        />
      ) : null}
      <span className="pointer-events-none absolute inset-0 rounded-[inherit] ring-1 ring-inset ring-black/[0.08] dark:ring-white/[0.14]" />
    </span>
  );
}
