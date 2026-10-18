/**
 * Geometry for a table header that must stay in view while its table scrolls
 * sideways (`app/table-client.tsx`, "shift" mode). DOM-free so it can be
 * tested.
 *
 * `top` is where the header should park (the site header's bottom edge);
 * `tableTop` is the table's current viewport offset. The header moves down
 * by however far the table has slid under `top`, and never past the point
 * where it would leave the table's own box — at the end of the table it
 * scrolls away with the last row instead of floating over the next section.
 */
export function stickyShift({
  top,
  tableTop,
  tableHeight,
  headHeight,
}: {
  top: number;
  tableTop: number;
  tableHeight: number;
  headHeight: number;
}): number {
  const room = Math.max(0, tableHeight - headHeight);
  return Math.round(Math.min(Math.max(0, top - tableTop), room));
}
