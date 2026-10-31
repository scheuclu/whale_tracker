import type { NextRequest } from "next/server";
import { isSameOrigin } from "@/lib/auth";
import { authBackend, clearSession, json, sessionEmail } from "@/lib/auth-routes";
import { originOf } from "@/lib/api-route";
import { getCoverage, getDataAsOf } from "@/lib/api-queries";
import { newUsage, parseChatBody, runChat, toContents, type ChatEvent } from "@/lib/chat-agent";
import { CHAT_DEFAULT_ROWS, CHAT_MAX_ROWS, chatConfig } from "@/lib/chat-config";
import { ChatModelError, geminiModel, scriptedModel } from "@/lib/chat-gemini";
import { chatSystemPrompt } from "@/lib/chat-prompt";
import { readChatQuota, recordChatTokens, refundChatMessage, reserveChatMessage, type ChatQuota } from "@/lib/chat-usage";
import { dataTools } from "@/lib/data-tools";
import { coverageLines } from "@/lib/methodology";
import { getSubscription } from "@/lib/subscription-store";
import { emailSubscriberKey } from "@/lib/subscription-token";

/**
 * The reader chat. `GET` says whether chat is on and how many of today's
 * messages the signed-in reader has left; `POST` answers one message.
 *
 * Signed-in readers only, because every answer is paid for (Gemini, on the
 * operator's key) and the account is what the daily limit counts against
 * (lib/chat-usage.ts). The session is read here, in a `no-store` route —
 * never in a page, which the CDN caches by URL (lib/auth.ts).
 *
 * The answer streams as NDJSON, one event per line, so the page can say
 * what is being looked up while it waits:
 *   {"type":"start","quota":…}  {"type":"tool","label":"Looking up NVDA"}
 *   {"type":"answer","text":"…","finish":"answer"}  {"type":"done","quota":…}
 *   {"type":"error","code":"busy","message":"…"}
 *
 * Nothing the reader writes is stored: the browser sends the conversation
 * with each message, it goes to Gemini, the answer comes back. The server
 * log gets counts only (tokens, calls, duration), never text or address.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_BODY_BYTES = 64 * 1024;

const ERROR_MESSAGES: Record<string, string> = {
  busy: "The chat is busy right now. Please try again in a minute.",
  unavailable: "The chat is unavailable right now. Please try again later.",
  failed: "Something went wrong while answering. Please try again.",
  blocked: "I can't answer that one. Try asking about a member, a ticker or a trade.",
  empty: "I couldn't put an answer together for that. Try rephrasing the question.",
};

type Ready = { config: NonNullable<ReturnType<typeof chatConfig>>; auth: NonNullable<ReturnType<typeof authBackend>> };

function ready(): Ready | null {
  const config = chatConfig();
  const auth = authBackend();
  return config && auth ? { config, auth } : null;
}

export async function GET(req: NextRequest) {
  const r = ready();
  if (!r) return json({ enabled: false });
  const email = sessionEmail(req, r.auth.secret);
  if (!email) return json({ enabled: true, signedIn: false }, 401);
  const quota = await readChatQuota(r.auth.backend, emailSubscriberKey(email, r.auth.secret), r.config.dailyLimit);
  // The canonical origin the answers' links are built on, so the page can
  // keep them in-app on a preview deployment too.
  return json({ enabled: true, signedIn: true, quota, siteOrigin: originOf(req) });
}

export async function POST(req: NextRequest) {
  if (!isSameOrigin(req)) return json({ error: "Cross-site request refused." }, 403);
  const r = ready();
  if (!r) return json({ error: "Chat is not available on this deployment.", code: "unconfigured" }, 503);
  const email = sessionEmail(req, r.auth.secret);
  if (!email) return json({ error: "Sign in to use the chat.", code: "signed_out" }, 401);

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return json({ error: "The conversation is too long. Start a new chat.", code: "too_long" }, 413);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: "Invalid JSON body.", code: "bad_request" }, 400);
  }
  const parsed = parseChatBody(body);
  if (!parsed.ok) return json({ error: parsed.error, code: "bad_request" }, 400);

  const { config, auth } = r;
  // A deleted account keeps no chat: the session outlived it.
  if (!(await getSubscription(auth.backend, auth.secret, email))) {
    return clearSession(json({ error: "Sign in to use the chat.", code: "signed_out" }, 401), req);
  }
  const id = emailSubscriberKey(email, auth.secret);
  const reservation = await reserveChatMessage(auth.backend, id, config);
  if (!reservation.ok) {
    const error =
      reservation.reason === "limit"
        ? `You have used today's ${config.dailyLimit} messages. They reset at midnight UTC.`
        : "The chat is resting for today: everyone's questions used up today's budget. It is back at midnight UTC.";
    return json({ error, code: reservation.reason, quota: reservation.quota }, 429);
  }

  const origin = originOf(req);
  const model = config.apiKey ? geminiModel({ apiKey: config.apiKey, model: config.model }) : scriptedModel();
  const tools = dataTools({ defaultRows: CHAT_DEFAULT_ROWS, maxRows: CHAT_MAX_ROWS });
  const usage = newUsage();
  const started = Date.now();
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const send = (event: Record<string, unknown>) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          open = false; // the reader went away; finish the bookkeeping anyway
        }
      };
      let finish = "error";
      let quota: ChatQuota = reservation.quota;
      send({ type: "start", quota });
      try {
        const [dataAsOf, coverage] = await Promise.all([getDataAsOf(), getCoverage().catch(() => null)]);
        const system = chatSystemPrompt({
          today: new Date().toISOString().slice(0, 10),
          dataAsOf,
          coverage: coverage ? coverageLines(coverage) : null,
        });
        const outcome = await runChat({
          model,
          tools,
          system,
          history: toContents(parsed.turns),
          ctx: { origin, defaultRows: CHAT_DEFAULT_ROWS, maxRows: CHAT_MAX_ROWS },
          thinkingLevel: config.thinkingLevel,
          usage,
          signal: req.signal,
          onEvent: (e: ChatEvent) => send({ type: "tool", name: e.name, label: e.label }),
        });
        finish = outcome.finish;
        if (outcome.text) {
          send({ type: "answer", text: outcome.text, finish: outcome.finish });
        } else {
          send({ type: "error", code: outcome.finish, message: ERROR_MESSAGES[outcome.finish] ?? ERROR_MESSAGES.failed });
        }
      } catch (err) {
        const code = err instanceof ChatModelError ? err.code : "failed";
        finish = `error:${err instanceof ChatModelError ? err.status : "internal"}`;
        console.error("chat: model call failed", err instanceof Error ? err.message : "unknown error");
        // Nothing was answered and nothing was spent: the message is given back.
        if (usage.tokens === 0) {
          await refundChatMessage(auth.backend, id).catch(() => null);
          quota = { ...quota, used: Math.max(0, quota.used - 1), remaining: Math.min(quota.limit, quota.remaining + 1) };
        }
        send({ type: "error", code, message: ERROR_MESSAGES[code] ?? ERROR_MESSAGES.failed });
      }
      await recordChatTokens(auth.backend, id, usage.tokens).catch(() => null);
      send({ type: "done", quota });
      console.info(
        JSON.stringify({
          event: "chat_message",
          finish,
          tokens: usage.tokens,
          model_calls: usage.modelCalls,
          tool_calls: usage.toolCalls,
          turns: parsed.turns.length,
          ms: Date.now() - started,
        })
      );
      if (open) {
        try {
          controller.close();
        } catch {
          /* already closed by the reader leaving */
        }
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
