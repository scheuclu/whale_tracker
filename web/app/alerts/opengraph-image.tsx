import { getAlertTotals } from "@/lib/alert-queries";
import { CARD_SIZE, cardDate, count, noun, renderPageCard } from "../share-card";

export const alt = "The FatCat Watch alert log: every alert sent, with the message as it went out";
export const size = CARD_SIZE;
export const contentType = "image/png";
export const revalidate = 3600;

export default async function Image() {
  const stats = [];
  try {
    const t = await getAlertTotals();
    const week = t.byKind.reduce((n, k) => n + (k.last_7d ?? 0), 0);
    stats.push(
      { value: count(t.total), label: `${noun(t.total, "alert")} sent` },
      { value: count(week), label: "in the last 7 days" }
    );
    const last = cardDate(t.last_fired);
    if (last) stats.push({ value: last, label: "last sent" });
  } catch {
    /* the card keeps its headline */
  }
  return renderPageCard({
    eyebrow: "Alert log",
    title: "Every alert the tracker sent",
    subtitle: "Congressional clusters, late STOCK Act filings, watched members and insider Form 4 rules, with the message as it went out.",
    stats,
    footnote: "Congressional alerts quote disclosed ranges · insider alerts quote shares × reported price",
  });
}
