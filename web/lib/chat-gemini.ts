/**
 * The Gemini API as the chat needs it: one `generateContent` call over REST,
 * with function declarations. Server-only; no SDK, so the request is exactly
 * what is written here and the tests can stand a scripted model in for it.
 *
 * Gemini 3 attaches a `thoughtSignature` to the parts of a turn that calls a
 * function, and refuses the follow-up unless that turn comes back verbatim.
 * The agent loop (`chat-agent.ts`) therefore returns the model's parts
 * untouched; nothing here rebuilds a model turn.
 */

import type { ToolSchema } from "./data-tools";

export type FunctionCall = { id?: string; name: string; args?: Record<string, unknown> };
export type FunctionResponse = { id?: string; name: string; response: Record<string, unknown> };

export type Part = {
  text?: string;
  /** A thought summary: never shown to the reader. */
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: FunctionCall;
  functionResponse?: FunctionResponse;
};

export type Content = { role: "user" | "model"; parts: Part[] };

export type GenerateRequest = {
  systemInstruction: { parts: { text: string }[] };
  contents: Content[];
  tools: { functionDeclarations: { name: string; description: string; parameters: ToolSchema }[] }[];
  toolConfig: { functionCallingConfig: { mode: "AUTO" | "NONE" } };
  generationConfig: { maxOutputTokens: number; thinkingConfig?: { thinkingLevel: string } };
};

export type GenerateResponse = {
  candidates?: { content?: Content; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    totalTokenCount?: number;
  };
};

export interface ChatModel {
  generate(req: GenerateRequest, signal?: AbortSignal): Promise<GenerateResponse>;
}

/**
 * What went wrong upstream, as a code the route maps to reader-facing words.
 * `busy`: Google rate-limited us; `unavailable`: billing, key or quota on
 * Google's side; `failed`: anything else (including our own malformed request).
 */
export class ChatModelError extends Error {
  readonly code: "busy" | "unavailable" | "failed";
  readonly status: number;
  constructor(code: "busy" | "unavailable" | "failed", status: number, message: string) {
    super(message);
    this.name = "ChatModelError";
    this.code = code;
    this.status = status;
  }
}

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
const TIMEOUT_MS = 30_000;

function errorCode(status: number): ChatModelError["code"] {
  if (status === 429) return "busy";
  if (status === 401 || status === 402 || status === 403) return "unavailable";
  return "failed";
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function geminiModel(o: {
  apiKey: string;
  model: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): ChatModel {
  const doFetch = o.fetch ?? fetch;
  const url = `${ENDPOINT}/${encodeURIComponent(o.model)}:generateContent`;
  return {
    async generate(req, signal) {
      // One retry for a rate limit or a server error: both are usually momentary.
      for (let attempt = 0; ; attempt++) {
        const timeout = AbortSignal.timeout(o.timeoutMs ?? TIMEOUT_MS);
        const res = await doFetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": o.apiKey },
          body: JSON.stringify(req),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
          cache: "no-store",
        }).catch((err: unknown) => {
          throw new ChatModelError("failed", 0, `Gemini request failed: ${(err as Error)?.name ?? "error"}`);
        });
        if (res.ok) return (await res.json()) as GenerateResponse;
        // Google's error text names the project and quota, not the reader;
        // it goes to the server log only (status + reason), never to the page.
        let reason = "";
        try {
          const body = (await res.json()) as { error?: { status?: string } };
          reason = body.error?.status ?? "";
        } catch {
          /* not JSON */
        }
        const retryable = res.status === 429 || res.status >= 500;
        if (retryable && attempt === 0) {
          await pause(800);
          continue;
        }
        throw new ChatModelError(errorCode(res.status), res.status, `Gemini ${res.status} ${reason}`.trim());
      }
    },
  };
}

/**
 * The e2e suite's model (`WHALE_TEST_FAKE_CHAT=1`): searches for the
 * question, then answers from what the search returned, so the route, the
 * tool loop and the page are exercised end to end against the committed
 * database without a key. Deterministic; 100 "tokens" a call.
 */
export function scriptedModel(): ChatModel {
  return {
    async generate(req) {
      const usageMetadata = { totalTokenCount: 100 };
      const last = req.contents[req.contents.length - 1];
      const response = last?.parts.find((p) => p.functionResponse)?.functionResponse;
      if (!response) {
        const question = last?.parts.map((p) => p.text ?? "").join(" ").trim() ?? "";
        const query = question.split(/\s+/).slice(-1)[0]?.replace(/[^\w.-]/g, "") || "pelosi";
        return {
          candidates: [
            {
              content: { role: "model", parts: [{ functionCall: { name: "search_site", args: { query } }, thoughtSignature: "test" }] },
              finishReason: "STOP",
            },
          ],
          usageMetadata,
        };
      }
      const result = (response.response.result ?? {}) as {
        query?: string;
        members?: { name: string; url: string; trades: number }[];
        tickers?: { symbol: string; url: string; trades: number }[];
      };
      const lines = [`Scripted answer for **${result.query ?? "?"}**:`];
      for (const m of (result.members ?? []).slice(0, 3)) lines.push(`- [${m.name}](${m.url}): ${m.trades} disclosed trades`);
      for (const t of (result.tickers ?? []).slice(0, 3)) lines.push(`- [${t.symbol}](${t.url}): ${t.trades} trades`);
      if (lines.length === 1) lines.push("The data has nothing on that.");
      return { candidates: [{ content: { role: "model", parts: [{ text: lines.join("\n") }] }, finishReason: "STOP" }], usageMetadata };
    },
  };
}
