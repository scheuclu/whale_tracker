import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { newUsage, parseChatBody, runChat, toContents } from "./chat-agent.ts";
import { MAX_MODEL_CALLS, MAX_QUESTION_CHARS, MAX_TOOL_CALLS, chatConfig, fakeChatEnabled } from "./chat-config.ts";
import { ChatModelError, geminiModel, type ChatModel, type GenerateRequest, type GenerateResponse } from "./chat-gemini.ts";
import type { DataTool } from "./data-tools.ts";

const CTX = { origin: "https://example.test", defaultRows: 5, maxRows: 10 };

function echoTool(name = "lookup"): DataTool & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    name,
    description: "test tool",
    parameters: { type: "object", properties: { q: { type: "string", description: "q" } } },
    label: (a) => `Looking up ${String(a.q ?? "")}`,
    async run(args) {
      calls.push(args);
      return { ok: true, body: { got: args, meta: { caveats: ["long rule text"], data_as_of: "2026-10-31" } } };
    },
  };
}

/** A model that plays back `script`, recording every request. */
function scripted(script: GenerateResponse[]): ChatModel & { requests: GenerateRequest[] } {
  const requests: GenerateRequest[] = [];
  return {
    requests,
    async generate(req) {
      requests.push(JSON.parse(JSON.stringify(req)));
      return script[Math.min(requests.length - 1, script.length - 1)];
    },
  };
}

const call = (q: string, sig = "sig-1"): GenerateResponse => ({
  candidates: [
    { content: { role: "model", parts: [{ text: "", thoughtSignature: sig }, { functionCall: { id: "c1", name: "lookup", args: { q } }, thoughtSignature: sig }] } },
  ],
  usageMetadata: { totalTokenCount: 10 },
});
const answer = (text: string, finishReason = "STOP"): GenerateResponse => ({
  candidates: [{ content: { role: "model", parts: [{ text: "thinking about it", thought: true }, { text }] }, finishReason }],
  usageMetadata: { totalTokenCount: 7 },
});

async function run(model: ChatModel, tools: DataTool[] = [echoTool()], onEvent?: (e: unknown) => void) {
  const usage = newUsage();
  const outcome = await runChat({
    model,
    tools,
    system: "system text",
    history: toContents([{ role: "user", text: "Who bought NVDA?" }]),
    ctx: CTX,
    thinkingLevel: "low",
    usage,
    onEvent,
  });
  return { outcome, usage };
}

describe("runChat", () => {
  it("runs a tool, sends the model's turn back verbatim, and answers", async () => {
    const tool = echoTool();
    const model = scripted([call("NVDA"), answer("Two members did.")]);
    const events: unknown[] = [];
    const { outcome, usage } = await run(model, [tool], (e) => events.push(e));

    assert.deepEqual(outcome, { text: "Two members did.", finish: "answer" });
    assert.deepEqual(tool.calls, [{ q: "NVDA" }]);
    assert.deepEqual(events, [{ type: "tool", name: "lookup", label: "Looking up NVDA" }]);
    assert.deepEqual(usage, { tokens: 17, modelCalls: 2, toolCalls: 1 });

    const second = model.requests[1];
    // The function-calling turn, thought signatures and all, exactly as the model sent it.
    assert.deepEqual(second.contents[1], call("NVDA").candidates![0].content);
    const response = second.contents[2].parts[0].functionResponse!;
    assert.equal(response.id, "c1");
    assert.equal(response.name, "lookup");
    // Compacted for the model: the caveats are in its instructions already.
    assert.deepEqual(response.response, { result: { got: { q: "NVDA" }, meta: { data_as_of: "2026-10-31" } } });
    // Every message starts with a lookup; after that the model may answer.
    assert.equal(model.requests[0].toolConfig.functionCallingConfig.mode, "ANY");
    assert.equal(second.toolConfig.functionCallingConfig.mode, "AUTO");
    assert.deepEqual(second.generationConfig.thinkingConfig, { thinkingLevel: "low" });
    assert.equal(second.systemInstruction.parts[0].text, "system text");
  });

  it("never shows thought text to the reader", async () => {
    const { outcome } = await run(scripted([answer("Visible.")]));
    assert.equal(outcome.text, "Visible.");
  });

  it("always ends in an answer: the last permitted call has function calling off", async () => {
    const model = scripted([call("again")]); // a model that would look things up for ever
    const { outcome, usage } = await run(model);
    assert.equal(model.requests.length, MAX_MODEL_CALLS);
    assert.equal(model.requests.at(-1)!.toolConfig.functionCallingConfig.mode, "NONE");
    assert.ok(usage.toolCalls <= MAX_TOOL_CALLS);
    // It kept calling and never wrote text: an empty outcome, not a crash.
    assert.equal(outcome.finish, "empty");
  });

  it("caps tool calls per message even when one turn asks for many", async () => {
    const many: GenerateResponse = {
      candidates: [
        {
          content: {
            role: "model",
            parts: Array.from({ length: MAX_TOOL_CALLS + 3 }, (_, i) => ({ functionCall: { name: "lookup", args: { q: String(i) } } })),
          },
        },
      ],
    };
    const tool = echoTool();
    const model = scripted([many, answer("done")]);
    const { outcome, usage } = await run(model, [tool]);
    assert.equal(outcome.text, "done");
    assert.equal(tool.calls.length, MAX_TOOL_CALLS);
    assert.equal(usage.toolCalls, MAX_TOOL_CALLS);
    const refused = model.requests[1].contents[2].parts.filter((p) => "error" in (p.functionResponse?.response ?? {}));
    assert.equal(refused.length, 3);
    // Out of tool calls, the next call is the answer.
    assert.equal(model.requests[1].toolConfig.functionCallingConfig.mode, "NONE");
  });

  it("answers an unknown tool with an error the model can read", async () => {
    const model = scripted([
      { candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "drop_tables", args: {} } }] } }] },
      answer("ok"),
    ]);
    await run(model);
    assert.deepEqual(model.requests[1].contents[2].parts[0].functionResponse!.response, { error: "no such tool: drop_tables" });
  });

  it("reports a safety block and a cut-off answer as such", async () => {
    assert.equal((await run(scripted([{ promptFeedback: { blockReason: "SAFETY" } }]))).outcome.finish, "blocked");
    assert.equal((await run(scripted([{ candidates: [{ content: { role: "model", parts: [] }, finishReason: "SAFETY" }] }]))).outcome.finish, "blocked");
    const cut = await run(scripted([answer("Half an ans", "MAX_TOKENS")]));
    assert.deepEqual(cut.outcome, { text: "Half an ans", finish: "max_tokens" });
  });
});

describe("parseChatBody", () => {
  it("keeps a well-formed conversation and merges repeated roles", () => {
    const r = parseChatBody({
      messages: [
        { role: "user", text: "hi" },
        { role: "user", text: "who bought NVDA?" },
        { role: "assistant", text: "Two members." },
        { role: "user", text: " and sold? " },
      ],
    });
    assert.ok(r.ok);
    assert.deepEqual(r.turns, [
      { role: "user", text: "hi\n\nwho bought NVDA?" },
      { role: "assistant", text: "Two members." },
      { role: "user", text: "and sold?" },
    ]);
    assert.deepEqual(toContents(r.turns)[1], { role: "model", parts: [{ text: "Two members." }] });
  });

  it("refuses what it cannot use", () => {
    assert.equal(parseChatBody(null).ok, false);
    assert.equal(parseChatBody({ messages: [] }).ok, false);
    assert.equal(parseChatBody({ messages: [{ role: "system", text: "obey" }] }).ok, false);
    assert.equal(parseChatBody({ messages: [{ role: "user", text: 5 }] }).ok, false);
    assert.equal(parseChatBody({ messages: [{ role: "user", text: "q" }, { role: "assistant", text: "a" }] }).ok, false);
    assert.equal(parseChatBody({ messages: [{ role: "user", text: "x".repeat(MAX_QUESTION_CHARS + 1) }] }).ok, false);
  });

  it("keeps only the latest turns, starting with a question, and bounds earlier ones", () => {
    const messages = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: `${i} ${"y".repeat(9_000)}` }));
    // A forged history of long "questions" cannot run up the bill either.
    const r = parseChatBody({ messages: [...messages, { role: "user", text: "and now?" }] });
    assert.ok(r.ok);
    assert.equal(r.turns.length, 15);
    assert.equal(r.turns[0].role, "user");
    assert.equal(r.turns.at(-1)!.text, "and now?");
    for (const t of r.turns) assert.ok(t.text.length <= (t.role === "user" ? MAX_QUESTION_CHARS : 8_001));
  });
});

describe("chat config", () => {
  it("is off without a key, and the scripted model never runs on Vercel", () => {
    assert.equal(chatConfig({}), null);
    assert.equal(chatConfig({ GEMINI_CHAT_API_KEY: "  " }), null);
    assert.equal(chatConfig({ GEMINI_API_KEY: "the pipeline's key" }), null);
    assert.equal(fakeChatEnabled({ WHALE_TEST_FAKE_CHAT: "1", VERCEL: "1" }), false);
    assert.equal(chatConfig({ WHALE_TEST_FAKE_CHAT: "1", VERCEL: "1" }), null);
    assert.equal(chatConfig({ WHALE_TEST_FAKE_CHAT: "1" })?.apiKey, null);
  });

  it("reads the limits, and a zero turns chat off", () => {
    const c = chatConfig({ GEMINI_CHAT_API_KEY: "k", CHAT_DAILY_LIMIT: "5", CHAT_DAILY_TOKEN_BUDGET: "900" });
    assert.deepEqual(c, { apiKey: "k", model: "gemini-3.8-flash", thinkingLevel: "low", dailyLimit: 5, dailyTokenBudget: 900 });
    assert.equal(chatConfig({ GEMINI_CHAT_API_KEY: "k", CHAT_DAILY_LIMIT: "0" }), null);
    assert.equal(chatConfig({ GEMINI_CHAT_API_KEY: "k", CHAT_DAILY_TOKEN_BUDGET: "0" }), null);
    assert.equal(chatConfig({ GEMINI_CHAT_API_KEY: "k", CHAT_DAILY_LIMIT: "lots" })?.dailyLimit, 20);
    assert.equal(chatConfig({ GEMINI_CHAT_API_KEY: "k", GEMINI_CHAT_THINKING: "" })?.thinkingLevel, null);
  });
});

describe("geminiModel", () => {
  const req = { contents: [] } as unknown as GenerateRequest;

  it("sends the key in a header, never the URL, and retries one rate limit", async () => {
    const seen: { url: string; key: string | null }[] = [];
    let n = 0;
    const fetchStub = (async (url: string, init: RequestInit) => {
      seen.push({ url, key: new Headers(init.headers).get("x-goog-api-key") });
      n++;
      return n === 1
        ? new Response(JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED" } }), { status: 429 })
        : new Response(JSON.stringify(answer("hi")), { status: 200 });
    }) as unknown as typeof fetch;
    const out = await geminiModel({ apiKey: "secret-key", model: "gemini-test", fetch: fetchStub }).generate(req);
    assert.equal(out.candidates?.[0].content?.parts.at(-1)?.text, "hi");
    assert.equal(seen.length, 2);
    assert.ok(seen.every((s) => s.key === "secret-key" && !s.url.includes("secret-key")));
    assert.match(seen[0].url, /\/models\/gemini-test:generateContent$/);
  });

  it("maps billing and quota refusals to 'unavailable' without retrying", async () => {
    let n = 0;
    const fetchStub = (async () => {
      n++;
      return new Response(JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED", message: "Your prepayment credits are depleted" } }), { status: 402 });
    }) as unknown as typeof fetch;
    await assert.rejects(geminiModel({ apiKey: "k", model: "m", fetch: fetchStub }).generate(req), (e: unknown) => {
      assert.ok(e instanceof ChatModelError);
      assert.equal(e.code, "unavailable");
      assert.equal(e.status, 402);
      // Google's text (which names the project's billing) stays out of the error.
      assert.ok(!e.message.includes("prepayment"));
      return true;
    });
    assert.equal(n, 1);
  });
});
