"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, RotateCcw, Square } from "lucide-react";
import { trackEvent } from "@/lib/analytics";
import { cn } from "@/lib/utils";
import { CHAT_DRAFT_KEY, CHAT_STORAGE_KEY, signInHref } from "../account-store";
import { Card } from "../charts";
import { BUTTON, BUTTON_PRIMARY, FOCUS_RING, StatusNote } from "../ui";
import { useAccount } from "../watchlist-client";
import { ChatMarkdown } from "./chat-markdown";

/**
 * The chat, entirely in the browser: the page around it is cached on the
 * CDN and identical for everyone (see app/chat/page.tsx).
 *
 * The conversation is kept in this tab only — React state, mirrored to
 * sessionStorage so following a link in an answer and coming back does not
 * lose it. It is sent with each message (the server keeps nothing), cleared
 * by "New chat", by signing out and by closing the tab.
 *
 * Analytics get counts and kinds only, never the text of a question.
 */

/** Mirrors MAX_QUESTION_CHARS in lib/chat-config.ts (server-only module). */
const MAX_QUESTION = 1_500;
const STORAGE_KEY = CHAT_STORAGE_KEY;
const DRAFT_KEY = CHAT_DRAFT_KEY;

const SUGGESTIONS = [
  "Who in Congress bought NVDA this year?",
  "What has Nancy Pelosi traded recently?",
  "Which stocks had the most buyers in the last 90 days?",
  "Which members file late most often?",
  "Whose trades were followed by the biggest market-beating moves?",
  "Have Lennar's insiders been buying or selling?",
];

type Quota = { used: number; limit: number; remaining: number; resetsAt: string };

type Message = {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** An assistant message being written: the lookups so far. */
  pending?: boolean;
  steps?: string[];
  error?: string;
};

type Status =
  | { state: "loading" }
  | { state: "signed_out" }
  | { state: "off" }
  | { state: "ready"; quota: Quota | null; siteOrigin: string | null };

function readStored(): Message[] {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (m): m is Message =>
          !!m && typeof m === "object" && (m.role === "user" || m.role === "assistant") && typeof m.text === "string"
      )
      .map((m, i) => ({ id: `s${i}`, role: m.role, text: m.text, ...(m.error ? { error: String(m.error) } : {}) }));
  } catch {
    return [];
  }
}

function store(messages: Message[]): void {
  try {
    const done = messages.filter((m) => !m.pending).map(({ role, text, error }) => ({ role, text, ...(error ? { error } : {}) }));
    if (done.length) window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(done));
    else window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage unavailable: the conversation simply does not survive a reload */
  }
}

function takeDraft(): string {
  try {
    const fromUrl = new URL(window.location.href).searchParams.get("q");
    if (fromUrl) return fromUrl.slice(0, MAX_QUESTION);
    const d = window.sessionStorage.getItem(DRAFT_KEY);
    window.sessionStorage.removeItem(DRAFT_KEY);
    return d?.slice(0, MAX_QUESTION) ?? "";
  } catch {
    return "";
  }
}

let nextId = 0;
const newId = () => `m${Date.now()}-${nextId++}`;

function resetTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  } catch {
    return "midnight UTC";
  }
}

export function ChatClient({ disclaimer }: { disclaimer: string }) {
  const account = useAccount();
  const [status, setStatus] = useState<Status>({ state: "loading" });
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const [origins, setOrigins] = useState<string[]>([]);
  // False until the stored conversation is read, so the first (empty) render cannot overwrite it.
  const [restored, setRestored] = useState(false);

  // The conversation and any draft, once, after hydration.
  useEffect(() => {
    setMessages(readStored());
    setInput(takeDraft());
    setOrigins([window.location.origin]);
    setRestored(true);
  }, []);

  useEffect(() => {
    if (account.status === "loading") return;
    if (account.status === "signed_out") {
      setStatus({ state: "signed_out" });
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/chat", { cache: "no-store" });
        const data = (await res.json().catch(() => ({}))) as { enabled?: boolean; quota?: Quota; siteOrigin?: string };
        if (cancelled) return;
        if (res.status === 401) setStatus({ state: "signed_out" });
        else if (!data.enabled) setStatus({ state: "off" });
        else {
          setStatus({ state: "ready", quota: data.quota ?? null, siteOrigin: data.siteOrigin ?? null });
          if (data.siteOrigin) setOrigins([window.location.origin, data.siteOrigin]);
        }
      } catch {
        if (!cancelled) setStatus({ state: "ready", quota: null, siteOrigin: null });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [account.status]);

  useEffect(() => {
    if (!restored) return;
    store(messages);
    const el = listRef.current?.lastElementChild;
    if (el && messages.length) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [messages, restored]);

  // Grow the field with what is typed, up to a few lines.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [input]);

  const patchLast = useCallback((change: (m: Message) => Message) => {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (!last || last.role !== "assistant") return prev;
      return [...prev.slice(0, -1), change(last)];
    });
  }, []);

  const send = useCallback(
    async (question: string, via: "typed" | "suggestion") => {
      const text = question.trim();
      if (!text || busy) return;
      if (status.state !== "ready") return;
      const history = messages
        .filter((m) => !m.pending && !m.error && m.text)
        .map((m) => ({ role: m.role, text: m.text }));
      const userMsg: Message = { id: newId(), role: "user", text };
      const pending: Message = { id: newId(), role: "assistant", text: "", pending: true, steps: [] };
      setMessages((prev) => [...prev.filter((m) => !m.pending), userMsg, pending]);
      setInput("");
      setBusy(true);
      const started = Date.now();
      trackEvent("chat_message_sent", { via, turn: Math.floor(history.length / 2) + 1, length: text.length > 200 ? "long" : "short" });

      const controller = new AbortController();
      abortRef.current = controller;
      let tools = 0;
      let answered = false;
      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: [...history, { role: "user", text }] }),
          cache: "no-store",
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string; quota?: Quota };
          if (res.status === 401) setStatus({ state: "signed_out" });
          if (data.quota) setStatus((s) => (s.state === "ready" ? { ...s, quota: data.quota! } : s));
          patchLast((m) => ({ ...m, pending: false, error: data.error ?? "Something went wrong. Please try again." }));
          trackEvent("chat_error", { code: data.code ?? String(res.status) });
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line) continue;
            let ev: { type?: string; label?: string; text?: string; message?: string; code?: string; quota?: Quota; finish?: string };
            try {
              ev = JSON.parse(line);
            } catch {
              continue;
            }
            if (ev.type === "tool" && ev.label) {
              tools++;
              patchLast((m) => ({ ...m, steps: [...(m.steps ?? []), ev.label!] }));
            } else if (ev.type === "answer" && typeof ev.text === "string") {
              answered = true;
              const cut = ev.finish === "max_tokens" ? "\n\n*(The answer was cut short. Ask for less at once.)*" : "";
              patchLast((m) => ({ ...m, text: ev.text! + cut }));
            } else if (ev.type === "error") {
              patchLast((m) => ({ ...m, error: ev.message ?? "Something went wrong. Please try again." }));
              trackEvent("chat_error", { code: ev.code ?? "unknown" });
            } else if ((ev.type === "start" || ev.type === "done") && ev.quota) {
              setStatus((s) => (s.state === "ready" ? { ...s, quota: ev.quota! } : s));
            }
          }
        }
        if (answered) trackEvent("chat_answer_received", { tools, seconds: Math.round((Date.now() - started) / 1000) });
      } catch (err) {
        const stopped = (err as Error)?.name === "AbortError";
        patchLast((m) => ({ ...m, error: m.text ? undefined : stopped ? "Stopped." : "The connection dropped. Please try again." }));
        if (stopped) trackEvent("chat_stopped", { tools });
      } finally {
        patchLast((m) => ({ ...m, pending: false, error: !m.text && !m.error ? "No answer came back. Please try again." : m.error }));
        abortRef.current = null;
        setBusy(false);
        inputRef.current?.focus();
      }
    },
    [busy, messages, patchLast, status.state]
  );

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    void send(input, "typed");
  };

  const newChat = () => {
    abortRef.current?.abort();
    setMessages([]);
    setInput("");
    trackEvent("chat_new");
    inputRef.current?.focus();
  };

  if (status.state === "loading") {
    return (
      <div className="h-48 animate-pulse rounded-tile bg-card shadow-card" aria-busy="true">
        <span className="sr-only">Loading the chat…</span>
      </div>
    );
  }

  if (status.state === "off") {
    return (
      <Card>
        <StatusNote tone="attention" as="p" className="text-[15px]">
          The chat is not available on this deployment.
        </StatusNote>
      </Card>
    );
  }

  if (status.state === "signed_out") {
    const signIn = (suggestion?: string) => {
      try {
        const draft = suggestion ?? input;
        if (draft.trim()) window.sessionStorage.setItem(DRAFT_KEY, draft.trim().slice(0, MAX_QUESTION));
      } catch {
        /* the draft is a convenience */
      }
      trackEvent("sign_in_start", { from: "chat" });
      window.location.assign(signInHref());
    };
    return (
      <Card className="space-y-5">
        <div className="space-y-2">
          <h2 className="text-[19px] font-semibold tracking-[-0.01em] text-foreground">Sign in to ask</h2>
          <p className="max-w-[60ch] text-[15px] leading-relaxed text-ink-2">
            The chat is free for signed-in readers, up to a daily limit. It looks every answer up in the filings
            this site has read and links you to them.
          </p>
        </div>
        <Suggestions onPick={(s) => signIn(s)} />
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className={BUTTON_PRIMARY} onClick={() => signIn()} data-chat-sign-in>
            Sign in to ask
          </button>
          <span className="text-[13px] text-muted-foreground">With Google or an emailed link. No password.</span>
        </div>
      </Card>
    );
  }

  const quota = status.quota;
  const outOfMessages = quota ? quota.remaining <= 0 : false;

  return (
    <div className="space-y-4">
      <Card className="space-y-5">
        {messages.length === 0 ? (
          <div className="space-y-3">
            <p className="text-[15px] text-ink-2">Ask about a member, a ticker, an insider or the rankings. For example:</p>
            <Suggestions onPick={(s) => void send(s, "suggestion")} disabled={busy || outOfMessages} />
          </div>
        ) : (
          <div ref={listRef} role="log" aria-live="polite" aria-relevant="additions text" className="space-y-5" data-chat-log>
            {messages.map((m) => (m.role === "user" ? <UserBubble key={m.id} text={m.text} /> : <Answer key={m.id} m={m} origins={origins} />))}
          </div>
        )}

        <form onSubmit={submit} className="space-y-2">
          <label className="sr-only" htmlFor="chat-input">
            Your question
          </label>
          <div
            data-chat-field
            className={cn(
              "flex items-end gap-2 rounded-[20px] border border-black/[0.06] bg-[var(--field)] p-1.5 pl-4 shadow-[inset_0_1px_2px_rgba(0,0,0,0.04)] dark:border-white/[0.08]",
              "focus-within:bg-card"
            )}
          >
            <textarea
              id="chat-input"
              ref={inputRef}
              rows={1}
              value={input}
              maxLength={MAX_QUESTION}
              disabled={outOfMessages}
              placeholder={outOfMessages ? "No messages left today" : "Ask about the trades…"}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send(input, "typed");
                }
              }}
              className="max-h-[180px] min-h-[36px] flex-1 resize-none bg-transparent py-2 text-[15px] leading-snug text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-60"
            />
            {busy ? (
              <button
                type="button"
                onClick={() => abortRef.current?.abort()}
                aria-label="Stop"
                className={cn("flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground", FOCUS_RING)}
              >
                <Square className="size-3.5 fill-current" aria-hidden />
              </button>
            ) : (
              <button
                type="submit"
                aria-label="Send"
                disabled={!input.trim() || outOfMessages}
                className={cn(
                  "flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-opacity disabled:opacity-30",
                  FOCUS_RING
                )}
              >
                <ArrowUp className="size-4" aria-hidden />
              </button>
            )}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-1 text-[12.5px] text-muted-foreground">
            <span data-chat-quota>
              {quota
                ? outOfMessages
                  ? `You've used today's ${quota.limit} messages. More at ${resetTime(quota.resetsAt)}.`
                  : `${quota.remaining} of ${quota.limit} messages left today`
                : null}
            </span>
            <span className="flex items-center gap-3">
              {input.length > MAX_QUESTION - 200 ? <span className="tabular">{MAX_QUESTION - input.length} characters left</span> : null}
              {messages.length > 0 ? (
                <button type="button" onClick={newChat} className={cn(BUTTON, "h-7 px-3 text-[12.5px]")}>
                  <RotateCcw className="size-3" aria-hidden /> New chat
                </button>
              ) : null}
            </span>
          </div>
        </form>
      </Card>
      <p className="max-w-[72ch] px-1 text-[12.5px] leading-relaxed text-muted-foreground">
        {disclaimer} Your questions are sent to Google to be answered and are not stored by this site.{" "}
        <a href="/privacy#chat" className="underline underline-offset-2 hover:text-foreground">
          Privacy
        </a>
      </p>
    </div>
  );
}

function Suggestions({ onPick, disabled }: { onPick: (s: string) => void; disabled?: boolean }) {
  return (
    <ul className="flex flex-wrap gap-2">
      {SUGGESTIONS.map((s) => (
        <li key={s}>
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              trackEvent("chat_suggestion_click", { index: SUGGESTIONS.indexOf(s) });
              onPick(s);
            }}
            className={cn(BUTTON, "h-auto whitespace-normal py-1.5 text-left text-[13px] leading-snug disabled:opacity-50")}
          >
            {s}
          </button>
        </li>
      ))}
    </ul>
  );
}

function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <p className="max-w-[85%] whitespace-pre-wrap break-words rounded-[18px] rounded-br-[6px] bg-fill px-4 py-2.5 text-[15px] leading-snug text-foreground">
        {text}
      </p>
    </div>
  );
}

function Answer({ m, origins }: { m: Message; origins: string[] }) {
  const steps = m.steps ?? [];
  return (
    <div className="space-y-2 text-[15px] leading-relaxed text-foreground" data-chat-answer>
      {m.pending && !m.text ? (
        <p className="flex items-center gap-2 text-[14px] text-muted-foreground" role="status">
          <span className="inline-flex gap-1" aria-hidden>
            <span className="size-1.5 animate-pulse rounded-full bg-muted-foreground" />
            <span className="size-1.5 animate-pulse rounded-full bg-muted-foreground [animation-delay:150ms]" />
            <span className="size-1.5 animate-pulse rounded-full bg-muted-foreground [animation-delay:300ms]" />
          </span>
          {steps.length ? `${steps[steps.length - 1]}…` : "Thinking…"}
        </p>
      ) : null}
      {m.text ? <ChatMarkdown text={m.text} origins={origins} /> : null}
      {m.error ? (
        <StatusNote tone="attention" as="p" className="text-[14px] text-ink-2">
          {m.error}
        </StatusNote>
      ) : null}
      {!m.pending && steps.length ? (
        <p className="text-[12px] text-muted-foreground">
          Looked up: {steps.map((s) => s.replace(/^(Looking up|Reading|Searching for|Checking) /, "")).join(" · ")}
        </p>
      ) : null}
    </div>
  );
}
