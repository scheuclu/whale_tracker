import type { NextRequest } from "next/server";
import { transactionsCsv } from "@/lib/csv";
import { exportFilename, parseTransactionFilters } from "@/lib/feed-filters";
import { getTransactions } from "@/lib/queries";
import { publicErrorMessage } from "@/lib/public-error";

export const dynamic = "force-dynamic";

/**
 * More rows than any filter has produced so far (the whole corpus is a few
 * thousand a year). Past it the response is a 413 asking for a narrower
 * filter, never a silently truncated file.
 */
const MAX_ROWS = 100_000;

function text(body: string, status: number): Response {
  return new Response(`${body}\n`, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

/**
 * The filtered feed, a member or a ticker as CSV. Takes exactly the feed's
 * query parameters (`?ticker=`, `?member=`, `?chamber=` …) so a feed URL
 * and its export name the same rows. Amounts are exported as min/max
 * columns; see lib/csv.ts.
 */
export async function GET(request: NextRequest) {
  const raw: Record<string, string> = {};
  for (const [k, v] of request.nextUrl.searchParams) raw[k] = v;
  const { filters, ignored } = parseTransactionFilters(raw);
  if (ignored.length) return text(`unrecognised filter value: ${ignored.join(", ")}`, 400);

  let rows;
  try {
    rows = await getTransactions({ ...filters, limit: MAX_ROWS + 1 });
  } catch (err) {
    return text(publicErrorMessage(err), 503);
  }
  if (rows.length > MAX_ROWS) return text(`more than ${MAX_ROWS} rows match; narrow the filter`, 413);

  return new Response(transactionsCsv(rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${exportFilename(filters)}"`,
      "Cache-Control": "no-store",
      "X-Row-Count": String(rows.length),
    },
  });
}
