import { getCommittee, getCommitteeMembers } from "@/lib/queries";
import { BUY, CARD_SIZE, SELL, count, noun, renderPageCard, renderPlainCard } from "../../../share-card";

/** The card for `/politicians?committee=<id>` (see app/cards/late for why it lives here). */

export const alt = "A congressional committee's members and their disclosed stock trades on FatCat Watch";
export const size = CARD_SIZE;
export const contentType = "image/png";
export const revalidate = 3600;

const CHAMBER: Record<string, string> = { house: "House", senate: "Senate", joint: "Joint" };

export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const id = decodeURIComponent((await params).id).toUpperCase();
  let committee = null;
  let members: Awaited<ReturnType<typeof getCommitteeMembers>> = [];
  try {
    [committee, members] = await Promise.all([getCommittee(id), getCommitteeMembers(id)]);
  } catch {
    /* fall back to the plain card */
  }
  if (!committee) return renderPlainCard("Congressional committees");

  const traders = members.filter((m) => m.trades > 0).length;
  const buys = members.reduce((n, m) => n + m.buys, 0);
  const sells = members.reduce((n, m) => n + m.sells, 0);
  const kind = committee.parent_id ? "subcommittee" : "committee";
  return renderPageCard({
    eyebrow: [`${CHAMBER[committee.chamber] ?? committee.chamber} ${kind}`, committee.parent_name ? `of ${committee.parent_name}` : null]
      .filter(Boolean)
      .join(" · "),
    title: committee.name,
    stats: [
      { value: count(members.length), label: noun(members.length, "seat") },
      { value: count(traders), label: `${noun(traders, "member")} trading` },
      { value: count(buys), label: noun(buys, "buy"), dot: BUY },
      { value: count(sells), label: noun(sells, "sell"), dot: SELL },
    ],
    footnote: "Each current seat holder's disclosed trades, whole record · amounts are filed as ranges",
  });
}
