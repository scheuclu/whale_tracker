import { serializeLd } from "@/lib/structured-data";

/** One JSON-LD block. Server-rendered; escaping lives in `serializeLd`. */
export function JsonLd({ data }: { data: Record<string, unknown> | Record<string, unknown>[] }) {
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeLd(data) }} />;
}
