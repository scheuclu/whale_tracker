/**
 * The contact form's rules: fields, limits, topics, the honeypot and the
 * rate limit's arithmetic.
 *
 * Pure — no node: builtins, no database, no next/headers — so the client
 * form can import the limits and the honeypot's name, and the tests can run
 * it under `node --test`. Hashing lives in contact-ip.ts, persistence in
 * contact-store.ts.
 */

export const CONTACT_LIMITS = {
  name: 100,
  email: 200,
  /** Room to describe a wrong row with a filing link; small enough that a spam run is cheap to store. */
  message: 4000,
  messageMin: 10,
} as const;

/**
 * Five messages an hour from one address is generous for a reader sending a
 * few corrections and tedious for a script. Counted against stored rows, so
 * the messages table is its own ledger: no second table, nothing to prune.
 */
export const CONTACT_RATE_LIMIT = { max: 5, windowMinutes: 60 } as const;

/** Whether a sender who already sent `recent` messages in the window is refused. */
export function isRateLimited(recent: number, max: number = CONTACT_RATE_LIMIT.max): boolean {
  return recent >= max;
}

/** Start of the rate-limit window ending at `now`. */
export function rateLimitSince(now: Date, windowMinutes: number = CONTACT_RATE_LIMIT.windowMinutes): Date {
  return new Date(now.getTime() - windowMinutes * 60_000);
}

/**
 * Why someone is writing. "Data correction" comes first because it is the
 * message this site most needs: a row that does not match its filing.
 */
export const CONTACT_TOPICS = [
  { value: "correction", label: "Data correction", hint: "Name the member or ticker and link the filing if you can." },
  { value: "press", label: "Press inquiry", hint: "Say which outlet and your deadline." },
  { value: "feedback", label: "Feedback", hint: "What works, what does not, what is missing." },
  { value: "other", label: "Something else", hint: "" },
] as const;

export type ContactTopic = (typeof CONTACT_TOPICS)[number]["value"];

const TOPIC_VALUES = new Set<string>(CONTACT_TOPICS.map((t) => t.value));

export function isContactTopic(value: unknown): value is ContactTopic {
  return typeof value === "string" && TOPIC_VALUES.has(value);
}

export function topicLabel(value: string): string {
  return CONTACT_TOPICS.find((t) => t.value === value)?.label ?? value;
}

/**
 * A field no human sees, and therefore never fills in. Named for something a
 * form-filling bot expects to complete rather than `honeypot`.
 */
export const HONEYPOT_FIELD = "website";

export interface ContactFields {
  topic: string;
  name: string;
  email: string;
  message: string;
}

export type ContactFieldErrors = Partial<Record<keyof ContactFields, string>>;

export const EMPTY_CONTACT_FIELDS: ContactFields = { topic: "", name: "", email: "", message: "" };

/** The submission's fields, trimmed; anything that is not a string reads as empty. */
export function readContactFields(formData: FormData): ContactFields {
  const str = (key: string) => {
    const value = formData.get(key);
    return typeof value === "string" ? value.trim() : "";
  };
  return { topic: str("topic"), name: str("name"), email: str("email"), message: str("message") };
}

/** True when the invisible field came back filled — i.e. not a person. */
export function looksLikeBot(formData: FormData): boolean {
  const value = formData.get(HONEYPOT_FIELD);
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Deliberately loose: one `@`, no whitespace, a dot in the domain. The only
 * real test of an address is replying to it; this catches typos, not fraud.
 */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@.]+$/;

// Control characters other than tab/newline/CR have no business in a message.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export type ContactValidation =
  | { ok: true; value: ContactFields & { topic: ContactTopic } }
  | { ok: false; errors: ContactFieldErrors };

/** At most one message per field, so the form never stacks two complaints on one input. */
export function validateContact(fields: ContactFields): ContactValidation {
  const errors: ContactFieldErrors = {};
  if (!isContactTopic(fields.topic)) errors.topic = "Choose what your message is about.";
  if (fields.name.length > CONTACT_LIMITS.name) {
    errors.name = `Keep the name under ${CONTACT_LIMITS.name} characters.`;
  } else if (CONTROL.test(fields.name)) {
    errors.name = "The name contains characters we cannot store.";
  }
  if (!fields.email) {
    errors.email = "Enter an email address so we can reply.";
  } else if (fields.email.length > CONTACT_LIMITS.email || !EMAIL.test(fields.email)) {
    errors.email = "That does not look like an email address.";
  }
  if (fields.message.length < CONTACT_LIMITS.messageMin) {
    errors.message = `Write at least ${CONTACT_LIMITS.messageMin} characters.`;
  } else if (fields.message.length > CONTACT_LIMITS.message) {
    errors.message = `Keep it under ${CONTACT_LIMITS.message.toLocaleString("en-US")} characters (this is ${fields.message.length.toLocaleString("en-US")}).`;
  } else if (CONTROL.test(fields.message)) {
    errors.message = "The message contains characters we cannot store.";
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: { ...fields, topic: fields.topic as ContactTopic } };
}

/** What the form renders after a submission. */
export interface ContactState {
  status: "idle" | "sent" | "error";
  errors: ContactFieldErrors;
  /** A problem with the submission as a whole rather than one field. */
  formError?: string;
  /**
   * Echoed back so a rejected submission does not empty the form — which
   * matters most without JavaScript, where the browser replaces the page
   * and anything not re-rendered is lost.
   */
  values: ContactFields;
}

/** The empty form; `topic` (from `?topic=`) preselects a topic only if it is a real one. */
export function initialContactState(topic = ""): ContactState {
  return { status: "idle", errors: {}, values: { ...EMPTY_CONTACT_FIELDS, topic: isContactTopic(topic) ? topic : "" } };
}

export const CONTACT_COPY = {
  rateLimited: "You have sent several messages in the last hour. Please wait a while before sending another.",
  unavailable: "Your message could not be saved just now. Please try again in a few minutes.",
} as const;
