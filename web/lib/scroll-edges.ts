/**
 * Horizontal-scroll geometry for the responsive layer (`app/scroll-area.tsx`).
 *
 * Kept free of the DOM so the rules can be tested: a 1px tolerance absorbs
 * sub-pixel scroll positions, which otherwise leave a "scroll for more" fade
 * showing on a container that is already at its end.
 */

export type ScrollMetrics = {
  scrollLeft: number;
  scrollWidth: number;
  clientWidth: number;
};

export type ScrollEdges = {
  /** The content is wider than the viewport, so scrolling is possible. */
  overflow: boolean;
  atStart: boolean;
  atEnd: boolean;
};

const TOLERANCE_PX = 1;

export function scrollEdges(m: ScrollMetrics): ScrollEdges {
  if (m.scrollWidth - m.clientWidth <= TOLERANCE_PX) {
    return { overflow: false, atStart: true, atEnd: true };
  }
  return {
    overflow: true,
    atStart: m.scrollLeft <= TOLERANCE_PX,
    atEnd: m.scrollLeft + m.clientWidth >= m.scrollWidth - TOLERANCE_PX,
  };
}

export function sameEdges(a: ScrollEdges, b: ScrollEdges): boolean {
  return a.overflow === b.overflow && a.atStart === b.atStart && a.atEnd === b.atEnd;
}

/**
 * The scrollLeft that keeps an item (the active nav tab) in view: unchanged
 * when it is already fully visible with `margin` to spare, otherwise the
 * offset that centres it. Centring does not depend on the current position,
 * so repeated calls settle rather than oscillate.
 */
export function revealOffset({
  scrollLeft,
  clientWidth,
  itemLeft,
  itemWidth,
  margin = 16,
}: {
  scrollLeft: number;
  clientWidth: number;
  itemLeft: number;
  itemWidth: number;
  margin?: number;
}): number {
  const visibleFrom = scrollLeft + margin;
  const visibleTo = scrollLeft + clientWidth - margin;
  if (itemLeft >= visibleFrom && itemLeft + itemWidth <= visibleTo) return scrollLeft;
  return Math.max(0, Math.round(itemLeft + itemWidth / 2 - clientWidth / 2));
}
