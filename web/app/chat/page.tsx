import { pageCard, pageMetadata } from "@/lib/seo";
import { CHAT_DISCLAIMER } from "@/lib/chat-prompt";
import { PAGE_STACK, PageHeader } from "../page-header";
import { ChatClient } from "./chat-client";

/**
 * Ask FatCat: a chat about the data for signed-in readers.
 *
 * The page itself is the same for everyone and cached on the CDN like any
 * other: whether the reader is signed in, their remaining messages and the
 * conversation are all fetched and kept in the browser (`ChatClient`, which
 * talks to `/api/chat`). Never read the session here — see lib/auth.ts.
 */

export const metadata = pageMetadata({
  title: "Ask FatCat",
  description:
    "Ask questions about congressional and corporate-insider stock trades in plain English. Answers come from FatCat Watch's data, with links to the filings.",
  path: "/chat",
  card: pageCard("/chat", "Ask FatCat: questions about congressional and insider stock trades, answered from the filings"),
});

export default function ChatPage() {
  return (
    <div className={PAGE_STACK}>
      <PageHeader
        eyebrow="Beta"
        title="Ask FatCat"
        subtitle="Questions about members' trades, the stocks they trade and insiders' Form 4 filings, answered from this site's data with links to the filings."
      />
      <ChatClient disclaimer={CHAT_DISCLAIMER} />
    </div>
  );
}
