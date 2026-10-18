import type { NextRequest } from "next/server";
import { optionsResponse, splitFormat } from "@/lib/api-format";
import { sendJson, sendMarkdown } from "@/lib/api-route";
import { memberMarkdown } from "@/lib/api-markdown";
import { buildMember, type MemberResult } from "@/lib/api-v1";

export const dynamic = "force-dynamic";

/** One member by Bioguide ID; `P000197.md` is the same response as Markdown. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id, markdown } = splitFormat((await params).id);
  const build = (origin: string, search: URLSearchParams) => buildMember(origin, id, search);
  return markdown ? sendMarkdown<MemberResult>(request, build, memberMarkdown) : sendJson(request, build);
}

export function OPTIONS() {
  return optionsResponse();
}
