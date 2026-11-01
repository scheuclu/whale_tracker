/**
 * One chat message, start to answer: the model is asked, any tools it calls
 * are run against the site's data (`data-tools.ts`), their results go back,
 * and so on until it answers in text. Pure apart from the model and the
 * tools it is handed, so the tests drive it with scripted ones.
 *
 * Every bound on cost lives here or in `chat-config.ts`: at most
 * `MAX_MODEL_CALLS` model calls and `MAX_TOOL_CALLS` tool calls, and the last
 * permitted call is made with function calling off so the message always
 * ends in an answer rather than a dangling lookup.
 *
 * The first call of every message must call a tool (mode ANY). Left to
 * choose, Gemini answered "Should I buy NVDA?" in one call with no lookup and
 * every figure invented (wrong trade, member and dollar counts, members who
 * never traded it), although the instructions say to look every figure up.
 * A forced lookup costs one extra call on a "thanks"; an invented figure is
 * the one answer this chat must never give.
 */

import {
  MAX_MODEL_CALLS,
  MAX_OUTPUT_TOKENS,
  MAX_QUESTION_CHARS,
  MAX_ANSWER_CHARS,
  MAX_HISTORY_MESSAGES,
  MAX_TOOL_CALLS,
  MAX_TOOL_RESULT_CHARS,
} from "./chat-config";
import type { ChatModel, Content, GenerateRequest, Part } from "./chat-gemini";
import { compactForModel, fitToChars, type DataTool, type ToolContext } from "./data-tools";

export type ChatEvent = { type: "tool"; name: string; label: string };

/** Running totals for one message, kept even when it fails midway: tokens spent are spent. */
export type ChatUsage = { tokens: number; modelCalls: number; toolCalls: number };

export type ChatOutcome = {
  text: string;
  /** `answer`; `max_tokens` (cut off, text may be partial); `blocked` (Gemini's safety filter); `empty`. */
  finish: "answer" | "max_tokens" | "blocked" | "empty";
};

export function newUsage(): ChatUsage {
  return { tokens: 0, modelCalls: 0, toolCalls: 0 };
}

const BLOCKED = new Set(["SAFETY", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "RECITATION", "IMAGE_SAFETY"]);

async function runTool(tool: DataTool | undefined, name: string, args: unknown, ctx: ToolContext): Promise<Record<string, unknown>> {
  if (!tool) return { error: `no such tool: ${name}` };
  try {
    const out = await tool.run((args && typeof args === "object" ? args : {}) as Record<string, unknown>, ctx);
    const body = fitToChars(compactForModel(out.body), MAX_TOOL_RESULT_CHARS);
    return out.ok ? { result: body } : (body as Record<string, unknown>);
  } catch {
    return { error: "the lookup failed; try a different question" };
  }
}

export async function runChat(o: {
  model: ChatModel;
  tools: DataTool[];
  system: string;
  history: Content[];
  ctx: ToolContext;
  thinkingLevel: string | null;
  usage: ChatUsage;
  onEvent?: (e: ChatEvent) => void;
  signal?: AbortSignal;
}): Promise<ChatOutcome> {
  const byName = new Map(o.tools.map((t) => [t.name, t]));
  const contents: Content[] = [...o.history];
  const base: Omit<GenerateRequest, "contents" | "toolConfig"> = {
    systemInstruction: { parts: [{ text: o.system }] },
    tools: [{ functionDeclarations: o.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) }],
    generationConfig: {
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      ...(o.thinkingLevel ? { thinkingConfig: { thinkingLevel: o.thinkingLevel } } : {}),
    },
  };

  for (let call = 0; call < MAX_MODEL_CALLS; call++) {
    if (o.signal?.aborted) return { text: "", finish: "empty" };
    const lastCall = call === MAX_MODEL_CALLS - 1 || o.usage.toolCalls >= MAX_TOOL_CALLS;
    const mode = lastCall ? "NONE" : call === 0 ? "ANY" : "AUTO";
    const res = await o.model.generate({ ...base, contents, toolConfig: { functionCallingConfig: { mode } } }, o.signal);
    o.usage.modelCalls++;
    o.usage.tokens += res.usageMetadata?.totalTokenCount ?? 0;

    if (res.promptFeedback?.blockReason) return { text: "", finish: "blocked" };
    const candidate = res.candidates?.[0];
    const parts: Part[] = candidate?.content?.parts ?? [];
    const calls = parts.filter((p) => p.functionCall);

    if (calls.length && !lastCall) {
      // The model's turn goes back verbatim: Gemini 3 checks the thought
      // signatures on a function-calling turn.
      contents.push({ role: "model", parts });
      const room = MAX_TOOL_CALLS - o.usage.toolCalls;
      const responses = await Promise.all(
        calls.map(async (p, i) => {
          const fc = p.functionCall!;
          const tool = byName.get(fc.name);
          let response: Record<string, unknown>;
          if (i >= room) {
            response = { error: "tool call limit reached for this message; answer with what you have" };
          } else {
            o.usage.toolCalls++;
            if (tool) o.onEvent?.({ type: "tool", name: tool.name, label: safeLabel(tool, fc.args) });
            response = await runTool(tool, fc.name, fc.args, o.ctx);
          }
          return { functionResponse: { ...(fc.id ? { id: fc.id } : {}), name: fc.name, response } } satisfies Part;
        })
      );
      contents.push({ role: "user", parts: responses });
      continue;
    }

    const text = parts
      .filter((p) => typeof p.text === "string" && !p.thought)
      .map((p) => p.text)
      .join("")
      .trim();
    const reason = candidate?.finishReason ?? "";
    if (!text) return { text: "", finish: BLOCKED.has(reason) ? "blocked" : "empty" };
    return { text, finish: reason === "MAX_TOKENS" ? "max_tokens" : "answer" };
  }
  return { text: "", finish: "empty" };
}

function safeLabel(tool: DataTool, args: unknown): string {
  try {
    return tool.label((args && typeof args === "object" ? args : {}) as Record<string, unknown>);
  } catch {
    return "Looking it up";
  }
}

/* ------------------------------------------------------------- the request */

export type ChatTurn = { role: "user" | "assistant"; text: string };

/**
 * The browser sends the conversation so far with every message (nothing is
 * kept on the server). Checked here: the last turn is the reader's question,
 * within `MAX_QUESTION_CHARS`; earlier answers are cut to `MAX_ANSWER_CHARS`;
 * only the latest `MAX_HISTORY_MESSAGES` turns are kept, starting with a
 * question; consecutive turns of one role are merged.
 */
export function parseChatBody(raw: unknown): { ok: true; turns: ChatTurn[] } | { ok: false; error: string } {
  const messages = (raw as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(messages) || messages.length === 0) return { ok: false, error: "messages must be a non-empty array" };
  if (messages.length > 200) return { ok: false, error: "too many messages" };
  const turns: ChatTurn[] = [];
  for (const m of messages) {
    const role = (m as { role?: unknown })?.role;
    const text = (m as { text?: unknown })?.text;
    if ((role !== "user" && role !== "assistant") || typeof text !== "string") {
      return { ok: false, error: "each message needs a role (user or assistant) and a text" };
    }
    const t = text.trim();
    if (!t) continue;
    const prev = turns[turns.length - 1];
    if (prev && prev.role === role) prev.text = `${prev.text}\n\n${t}`;
    else turns.push({ role, text: t });
  }
  const last = turns[turns.length - 1];
  if (!last || last.role !== "user") return { ok: false, error: "the last message must be the reader's question" };
  if (last.text.length > MAX_QUESTION_CHARS) return { ok: false, error: `a question can be at most ${MAX_QUESTION_CHARS} characters` };
  let kept = turns.slice(-MAX_HISTORY_MESSAGES);
  while (kept.length && kept[0].role !== "user") kept = kept.slice(1);
  kept = kept.map((t) =>
    t.role === "assistant" && t.text.length > MAX_ANSWER_CHARS ? { ...t, text: `${t.text.slice(0, MAX_ANSWER_CHARS)}…` } : t
  );
  // Earlier questions are bounded too, so a forged history cannot run up the bill.
  kept = kept.map((t) => (t.role === "user" && t.text.length > MAX_QUESTION_CHARS ? { ...t, text: t.text.slice(0, MAX_QUESTION_CHARS) } : t));
  return { ok: true, turns: kept };
}

export function toContents(turns: ChatTurn[]): Content[] {
  return turns.map((t) => ({ role: t.role === "user" ? "user" : "model", parts: [{ text: t.text }] }));
}
