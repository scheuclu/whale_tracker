"use client";

import { useActionState, useEffect, useRef } from "react";
import { CheckCircle2 } from "lucide-react";
import Link from "next/link";

import { CONTACT_LIMITS, CONTACT_TOPICS, HONEYPOT_FIELD, initialContactState } from "@/lib/contact";
import { cn } from "@/lib/utils";
import { BUTTON, BUTTON_PRIMARY, FIELD, FOCUS_RING } from "../ui";
import { submitContactMessage } from "./actions";

const LABEL = "block text-[13px] font-medium text-foreground";
const HELP = "mt-1 text-xs text-muted-foreground";
const ERROR = "mt-1 text-xs font-medium text-error";

/**
 * The contact form. A client component only for `useActionState`; every
 * control is a plain form field posting to a server action, so it works the
 * same before hydration and with JavaScript off (the server renders the
 * returned state into the page it sends back).
 */
export function ContactForm({ topic }: { topic: string }) {
  const [state, action, pending] = useActionState(submitContactMessage, initialContactState(topic));
  const formRef = useRef<HTMLFormElement>(null);

  // After a rejected attempt, move focus to the first thing to fix (or to the
  // form-level message), so a keyboard or screen-reader user lands on it.
  useEffect(() => {
    if (state.status !== "error") return;
    const form = formRef.current;
    const first = state.errors.topic
      ? form?.querySelector<HTMLElement>('input[name="topic"]')
      : form?.querySelector<HTMLElement>('[aria-invalid="true"], [role="alert"]');
    first?.focus();
  }, [state]);

  if (state.status === "sent") {
    return (
      <div role="status" className="flex gap-3 rounded-xl border border-ok/25 bg-ok-soft p-4 sm:p-5">
        <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-ok" aria-hidden />
        <div className="space-y-2 text-sm">
          <p className="font-semibold text-foreground">Message sent — thank you.</p>
          <p className="text-muted-foreground">
            We read every message and reply by email to the address you gave, usually within a few days.
          </p>
          {/* A full load, not a client navigation: a fresh form, with or without JS. */}
          <a href="/contact" className={cn(BUTTON, "mt-1")}>
            Send another message
          </a>
        </div>
      </div>
    );
  }

  const v = state.values;
  const err = state.errors;
  const described = (field: string, help?: boolean) =>
    [help ? `${field}-help` : null, err[field as keyof typeof err] ? `${field}-error` : null].filter(Boolean).join(" ") ||
    undefined;

  return (
    // `key` remounts the fields with the echoed values after each attempt, so
    // React's post-action form reset cannot blank what the reader typed.
    <form ref={formRef} key={JSON.stringify(v)} action={action} noValidate className="space-y-5">
      {state.formError ? (
        <p role="alert" tabIndex={-1} className="rounded-control border border-error/25 bg-error-soft px-3 py-2 text-sm text-error outline-none">
          {state.formError}
        </p>
      ) : null}

      <fieldset aria-describedby={err.topic ? "topic-error" : undefined}>
        <legend className={LABEL}>What is it about?</legend>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {CONTACT_TOPICS.map((t) => (
            <label
              key={t.value}
              className={cn(
                "flex cursor-pointer gap-2.5 rounded-control border border-border bg-[var(--card-solid)] p-3",
                "transition-[border-color,background-color] duration-(--dur) hover:border-border-strong",
                "has-[:checked]:border-primary has-[:checked]:bg-accent has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring has-[:focus-visible]:outline-solid"
              )}
            >
              <input
                type="radio"
                name="topic"
                value={t.value}
                defaultChecked={v.topic === t.value}
                required
                className="mt-0.5 size-4 shrink-0 accent-[var(--primary)] outline-none"
              />
              <span className="min-w-0">
                <span className="block text-[13px] font-medium text-foreground">{t.label}</span>
                {t.hint ? <span className="block text-xs text-muted-foreground">{t.hint}</span> : null}
              </span>
            </label>
          ))}
        </div>
        {err.topic ? (
          <p id="topic-error" className={ERROR}>
            {err.topic}
          </p>
        ) : null}
      </fieldset>

      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <label htmlFor="contact-name" className={LABEL}>
            Name <span className="font-normal text-muted-foreground">(optional)</span>
          </label>
          <input
            id="contact-name"
            name="name"
            type="text"
            autoComplete="name"
            maxLength={CONTACT_LIMITS.name}
            defaultValue={v.name}
            aria-invalid={err.name ? true : undefined}
            aria-describedby={described("name")}
            className={cn(FIELD, "mt-1.5 h-10 text-base sm:h-9 sm:text-sm", FOCUS_RING)}
          />
          {err.name ? (
            <p id="name-error" className={ERROR}>
              {err.name}
            </p>
          ) : null}
        </div>
        <div>
          <label htmlFor="contact-email" className={LABEL}>
            Email
          </label>
          <input
            id="contact-email"
            name="email"
            type="email"
            autoComplete="email"
            required
            maxLength={CONTACT_LIMITS.email}
            defaultValue={v.email}
            aria-invalid={err.email ? true : undefined}
            aria-describedby={described("email")}
            className={cn(FIELD, "mt-1.5 h-10 text-base sm:h-9 sm:text-sm", FOCUS_RING)}
          />
          {err.email ? (
            <p id="email-error" className={ERROR}>
              {err.email}
            </p>
          ) : null}
        </div>
      </div>

      <div>
        <label htmlFor="contact-message" className={LABEL}>
          Message
        </label>
        <textarea
          id="contact-message"
          name="message"
          required
          rows={7}
          minLength={CONTACT_LIMITS.messageMin}
          maxLength={CONTACT_LIMITS.message}
          defaultValue={v.message}
          aria-invalid={err.message ? true : undefined}
          aria-describedby={described("message", true)}
          className={cn(FIELD, "mt-1.5 h-auto min-h-36 resize-y py-2 text-base leading-relaxed sm:text-sm", FOCUS_RING)}
        />
        <p id="message-help" className={HELP}>
          {CONTACT_LIMITS.messageMin}–{CONTACT_LIMITS.message.toLocaleString("en-US")} characters. For a data
          correction, a link to the filing or the row on this site helps most.
        </p>
        {err.message ? (
          <p id="message-error" className={ERROR}>
            {err.message}
          </p>
        ) : null}
      </div>

      {/* The honeypot. Off-screen rather than display:none (which some bots
          skip), hidden from assistive tech, and out of the tab order. */}
      <div aria-hidden="true" className="absolute -left-[10000px] top-auto size-px overflow-hidden">
        <label htmlFor={`contact-${HONEYPOT_FIELD}`}>Website</label>
        <input id={`contact-${HONEYPOT_FIELD}`} name={HONEYPOT_FIELD} type="text" tabIndex={-1} autoComplete="off" defaultValue="" />
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <button type="submit" disabled={pending} className={cn(BUTTON_PRIMARY, "h-10 px-5 text-sm disabled:opacity-60 sm:h-9")}>
          {pending ? "Sending…" : "Send message"}
        </button>
        <p className="text-xs text-muted-foreground">
          We store your message, email address and a hashed IP address (to limit abuse) — see the{" "}
          <Link href="/privacy" className="rounded-sm underline decoration-border-strong underline-offset-2 hover:text-primary">
            privacy policy
          </Link>
          .
        </p>
      </div>
    </form>
  );
}
