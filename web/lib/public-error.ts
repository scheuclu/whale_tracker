/**
 * An error's message as it may be shown to a reader or returned by the API.
 *
 * Pages and route handlers catch a failed database read and say what went
 * wrong in place — that message is useful ("trade database fetch failed:
 * 401 — token invalid or expired") and is kept. What is not kept: a stack
 * (only the first line of `message` is ever read), a server filesystem path
 * (a local run names the database file; a SQLite or Node error can name a
 * temp file), anything shaped like a credential, and unbounded length.
 */

const MAX_LENGTH = 300;

/**
 * Absolute POSIX or Windows paths of two or more segments. The lookbehind
 * keeps a URL's path (`https://host/a/b`) and a relative `owner/name` intact:
 * a filesystem path starts after a space, quote or bracket, never after a
 * word character, colon, slash or dot.
 */
const FS_PATH = /(?<![\w:/.\\-])(?:[A-Za-z]:\\|\/)(?:[\w.@+-]+[\\/])+[\w.@+-]*/g;

/** GitHub tokens (classic and fine-grained), bearer values, query-string secrets. */
const SECRETS: [RegExp, string][] = [
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[redacted]"],
  [/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]"],
  [/([?&](?:token|key|secret|sig|signature|access_token)=)[^&\s]+/gi, "$1[redacted]"],
];

export function publicErrorMessage(error: unknown): string {
  let message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  message = message.split("\n")[0];
  for (const [re, replacement] of SECRETS) message = message.replace(re, replacement);
  message = message.replace(FS_PATH, "[path]").trim();
  if (message.length > MAX_LENGTH) message = `${message.slice(0, MAX_LENGTH - 1)}…`;
  return message || "unexpected error";
}
