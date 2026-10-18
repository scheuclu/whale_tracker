import { resolveMemberSlug } from "@/lib/entities";
import { initials, portraitUrl } from "@/lib/members";
import { getPoliticianDetail } from "@/lib/queries";
import { chamberTitle } from "@/lib/site";
import { BUY, CARD_SIZE, SELL, count, renderCard, renderPlainCard } from "../../share-card";

export const alt = "A member of Congress's disclosed stock trades on Whale Tracker: trade, ticker and buy/sell counts";
export const size = CARD_SIZE;
export const contentType = "image/png";
// Counts move only when the pipeline commits; link previews are cached by
// the sites that fetch them anyway.
export const revalidate = 3600;

/**
 * The official portrait as a data URI, or null. Fetched up front rather than
 * handed to the renderer as a URL: a member with no portrait yet (a 404)
 * would otherwise fail the whole card instead of falling back to initials.
 */
async function portrait(bioguideId: string | null): Promise<string | null> {
  const url = portraitUrl(bioguideId, "450x550");
  if (!url) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    const type = res.headers.get("content-type") ?? "image/jpeg";
    if (!type.startsWith("image/")) return null;
    return `data:${type};base64,${Buffer.from(await res.arrayBuffer()).toString("base64")}`;
  } catch {
    return null;
  }
}

export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  let ref, detail;
  try {
    ref = await resolveMemberSlug(decodeURIComponent(slug));
    detail = ref ? await getPoliticianDetail(ref.name) : null;
  } catch {
    /* fall back to the plain card */
  }
  if (!ref || !detail) return renderPlainCard(ref?.name ?? "Member of Congress");

  const photo = await portrait(ref.bioguideId);
  const seat = [detail.party, detail.state ? `${detail.state}${detail.district && detail.district !== "0" ? `-${detail.district}` : ""}` : null]
    .filter(Boolean)
    .join("-");
  const job = chamberTitle(detail.chamber);
  const span =
    detail.first_tx_date && detail.last_tx_date
      ? `trades dated ${detail.first_tx_date.slice(0, 7)} to ${detail.last_tx_date.slice(0, 7)}`
      : null;

  return renderCard({
    body: (
      <div style={{ display: "flex", alignItems: "center", gap: 40 }}>
        <div
          style={{
            display: "flex",
            width: 176,
            height: 176,
            borderRadius: 52,
            overflow: "hidden",
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: "rgba(255,255,255,0.08)",
            border: "1px solid rgba(255,255,255,0.12)",
            fontSize: 64,
            color: "#c9c9d6",
          }}
        >
          {photo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={photo} width={176} height={215} alt="" style={{ objectFit: "cover", marginTop: 30 }} />
          ) : (
            initials(ref.name)
          )}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10, maxWidth: 820 }}>
          <div style={{ display: "flex", fontSize: ref.name.length > 26 ? 56 : 68, lineHeight: 1.05, letterSpacing: "-0.035em" }}>
            {ref.name}
          </div>
          <div style={{ display: "flex", fontSize: 28, color: "#a3a3b8" }}>
            {[job, seat].filter(Boolean).join(" · ") || "Filer not matched to the congressional roster"}
          </div>
        </div>
      </div>
    ),
    stats: [
      { value: count(detail.trades), label: detail.trades === 1 ? "disclosed trade" : "disclosed trades" },
      { value: count(detail.tickers), label: detail.tickers === 1 ? "ticker" : "tickers" },
      { value: count(detail.buys), label: detail.buys === 1 ? "buy" : "buys", dot: BUY },
      { value: count(detail.sells), label: detail.sells === 1 ? "sell" : "sells", dot: SELL },
    ],
    footnote: [`${count(detail.filings)} STOCK Act filing${detail.filings === 1 ? "" : "s"}`, span, "amounts are filed as ranges"]
      .filter(Boolean)
      .join(" · "),
  });
}
