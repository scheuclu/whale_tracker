/**
 * The reader chat's configuration, from the environment. Server-only.
 *
 * Chat answers come from Google's Gemini API on the operator's key, so every
 * limit here is a cost bound, and a missing piece switches the feature off
 * rather than running it unbounded:
 *
 * - `GEMINI_CHAT_API_KEY` — a key of its own, not the pipeline's
 *   `GEMINI_API_KEY`: rate limits are per Google project, and a busy chat day
 *   must not starve the scanned-filing transcription. Use a project on the
 *   paid tier: free-tier prompts are used to improve Google's products, and
 *   /privacy says they are not.
 * - `CHAT_DAILY_LIMIT` — messages per account per UTC day (default 20).
 * - `CHAT_DAILY_TOKEN_BUDGET` — Gemini tokens for everyone together per UTC
 *   day (default 2,000,000); once spent, chat rests until midnight UTC. `0`
 *   turns chat off without removing the key.
 * - `GEMINI_CHAT_MODEL` (default `gemini-3.8-flash`, the pipeline's model)
 *   and `GEMINI_CHAT_THINKING` (default `low`; empty omits the setting).
 *
 * The e2e suite runs the whole route against a scripted model instead of
 * Gemini (`WHALE_TEST_FAKE_CHAT=1`), refused on Vercel like the in-memory
 * account store, so a stray variable there cannot answer readers with it.
 */

type Env = Record<string, string | undefined>;

export const DEFAULT_CHAT_MODEL = "gemini-3.8-flash";
export const DEFAULT_DAILY_LIMIT = 20;
export const DEFAULT_DAILY_TOKEN_BUDGET = 2_000_000;
export const DEFAULT_THINKING_LEVEL = "low";

/** Per message: model calls (tool rounds plus the answer) and tool calls. */
export const MAX_MODEL_CALLS = 6;
export const MAX_TOOL_CALLS = 8;
/** Output tokens per model call, thinking included. */
export const MAX_OUTPUT_TOKENS = 4096;
/** A tool result is cut to fit this many characters (~6k tokens) before the model sees it. */
export const MAX_TOOL_RESULT_CHARS = 24_000;
/** Rows a chat tool returns by default, and at most. */
export const CHAT_DEFAULT_ROWS = 15;
export const CHAT_MAX_ROWS = 40;
/** The request: turns kept, characters per question and per earlier answer. */
export const MAX_HISTORY_MESSAGES = 16;
export const MAX_QUESTION_CHARS = 1_500;
export const MAX_ANSWER_CHARS = 8_000;

export type ChatConfig = {
  /** `null` when the scripted test model answers instead. */
  apiKey: string | null;
  model: string;
  thinkingLevel: string | null;
  dailyLimit: number;
  dailyTokenBudget: number;
};

export function fakeChatEnabled(env: Env = process.env): boolean {
  return env.WHALE_TEST_FAKE_CHAT === "1" && !env.VERCEL;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const s = raw?.trim();
  if (!s) return fallback;
  if (!/^\d+$/.test(s)) return fallback;
  return Number(s);
}

/** The chat's settings, or null when it is switched off on this deployment. */
export function chatConfig(env: Env = process.env): ChatConfig | null {
  const fake = fakeChatEnabled(env);
  // Blank reads as unset: an undefined secret often arrives as "".
  const apiKey = env.GEMINI_CHAT_API_KEY?.trim() || null;
  if (!apiKey && !fake) return null;
  const dailyLimit = positiveInt(env.CHAT_DAILY_LIMIT, DEFAULT_DAILY_LIMIT);
  const dailyTokenBudget = positiveInt(env.CHAT_DAILY_TOKEN_BUDGET, DEFAULT_DAILY_TOKEN_BUDGET);
  if (dailyLimit === 0 || dailyTokenBudget === 0) return null;
  const thinking = env.GEMINI_CHAT_THINKING;
  return {
    apiKey: fake ? null : apiKey,
    model: env.GEMINI_CHAT_MODEL?.trim() || DEFAULT_CHAT_MODEL,
    thinkingLevel: thinking === undefined ? DEFAULT_THINKING_LEVEL : thinking.trim() || null,
    dailyLimit,
    dailyTokenBudget,
  };
}
