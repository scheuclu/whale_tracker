"use client";

import Image from "next/image";
import { useState } from "react";
import { initials, portraitUrl } from "@/lib/members";
import { cn } from "@/lib/utils";

/**
 * Rendered edge in CSS pixels. next/image picks the 1x/2x candidates from
 * `images.imageSizes` (32, 48, 64, 96, 128, 256), so a 24px avatar costs a
 * ~2 KB 48px WebP instead of the 56 KB 225×275 JPEG.
 *
 * The scale, on the 4px grid: xs 20 (dense inline mentions) · sm 24 (table
 * and list rows) · md 32 (cards, search results) · lg 40 (roster tiles) ·
 * xl 88/112 (the member hero).
 */
const PX = { xs: 20, sm: 24, md: 32, lg: 40, xl: 120 } as const;

/**
 * Monogram type per size: small sizes get a touch more weight and less
 * relative size so two capitals do not crowd the circle.
 */
const MONO_TYPE: Record<Exclude<AvatarSize, "xl">, string> = {
  xs: "text-[8px] tracking-[0.02em]",
  sm: "text-[9.5px] tracking-[0.02em]",
  md: "text-[12px] tracking-[0.01em]",
  lg: "text-[14px]",
};

export type AvatarSize = keyof typeof PX;

/**
 * A member's official portrait, cropped to the face, over a monogram.
 *
 * The monogram is always rendered and the photo is laid on top of it, so
 * there is no state in which the reader sees an empty circle or a
 * broken-image icon:
 *
 * - the photo is transparent until it has actually loaded, then fades in,
 *   so the initials show while it is in flight (it is lazy);
 * - when there is no bioguide id, or it is not one, no request is made;
 * - when the request fails (a new member has no portrait yet) the photo
 *   never becomes visible — Chrome draws its broken-image glyph even for
 *   `alt=""` when the box has a size, so visibility has to be earned by a
 *   load, not revoked by an error — and `onError` then removes it.
 *   next/image replays a load or error that happened before hydration.
 *   Without JavaScript the reader gets the monograms, never a broken icon.
 *
 * Decorative by design: every caller prints the member's name beside it.
 * Neutral by design too — party is never tinted, because blue↔red is the
 * buy/sell encoding everywhere on this site.
 */
export function MemberAvatar({
  name,
  bioguideId,
  size = "md",
  className,
}: {
  name: string;
  bioguideId?: string | null;
  size?: AvatarSize;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const src = failed ? null : portraitUrl(bioguideId);
  const px = PX[size];
  const xl = size === "xl";

  return (
    <span
      aria-hidden
      data-avatar={src ? "portrait" : "monogram"}
      className={cn(
        "relative inline-flex shrink-0 select-none items-center justify-center overflow-hidden",
        // Monogram surface: the card surface with a few percent of ink mixed
        // in, initials at mid ink. Neutral in both modes, never a party hue.
        "bg-[color-mix(in_oklab,var(--foreground)_6%,var(--card-solid))] text-[color-mix(in_oklab,var(--foreground)_58%,var(--card-solid))]",
        "dark:bg-[color-mix(in_oklab,var(--foreground)_9%,var(--card-solid))] dark:text-[color-mix(in_oklab,var(--foreground)_66%,var(--card-solid))]",
        // The hero portrait steps down on a phone so the name keeps its line.
        xl ? "size-[96px] rounded-full text-[32px] sm:size-[120px] sm:text-[40px]" : cn("rounded-full", MONO_TYPE[size]),
        className
      )}
      style={xl ? undefined : { width: px, height: px }}
    >
      <span className="font-semibold leading-none">{initials(name)}</span>
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
            // A decode failure is reported as a load with no pixels.
            if ((e.currentTarget as HTMLImageElement).naturalWidth) setLoaded(true);
            else setFailed(true);
          }}
          className={cn(
            "absolute inset-0 size-full object-cover transition-opacity duration-300 motion-reduce:transition-none",
            loaded ? "opacity-100" : "opacity-0",
            // Portraits are 225×275 head-and-shoulders shots with the face a
            // little above centre. Small sizes zoom in so a 24px circle is
            // a face, not a suit; the hero keeps more of the frame.
            xl ? "object-[50%_22%]" : "origin-[50%_32%] scale-[1.18] object-[50%_18%]"
          )}
        />
      ) : null}
      {/* The hairline ring sits above the photo, so it stays crisp on both. */}
      <span className="pointer-events-none absolute inset-0 rounded-[inherit] ring-1 ring-inset ring-black/[0.08] dark:ring-white/[0.1]" />
    </span>
  );
}
