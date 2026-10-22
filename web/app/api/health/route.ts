import { getDb } from "@/lib/db";
import { assessHealth, readHealthInputs, staleAfterHours, type HealthInputs } from "@/lib/health";

export const dynamic = "force-dynamic";

/**
 * For uptime monitors: 200 with `"status": "ok"` when the database is
 * readable and the pipeline wrote within the threshold, 503 with
 * `"status": "degraded"` and the reasons otherwise — so a monitor can alert
 * on the status code alone. Never cached anywhere (a cached "ok" would hide
 * the outage it exists to report). Verdict and fields: lib/health.ts.
 */
export async function GET() {
  let inputs: HealthInputs | null = null;
  try {
    inputs = readHealthInputs(await getDb());
  } catch (err) {
    // The cause goes to the runtime log, not the response.
    console.error("health: database unreadable", err);
  }
  const report = assessHealth(inputs, { staleAfter: staleAfterHours() });
  return Response.json(report, {
    status: report.status === "ok" ? 200 : 503,
    headers: {
      "Cache-Control": "no-store, max-age=0",
      "CDN-Cache-Control": "no-store",
      "X-Robots-Tag": "noindex",
    },
  });
}

export async function HEAD() {
  const res = await GET();
  return new Response(null, { status: res.status, headers: res.headers });
}
