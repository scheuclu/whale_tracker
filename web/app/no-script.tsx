/**
 * The page as plain HTML for a browser with JavaScript off.
 *
 * Every route streams behind a `loading.tsx` boundary, so the first HTML a
 * browser receives is the skeleton; the real content follows at the end of
 * `<body>` inside `<div hidden id="S:n">`, and a tiny inline script (`$RC`)
 * swaps it into place. With scripting disabled that swap never runs, so the
 * reader is left on the skeleton forever, and the sort links and filter
 * forms that were built to work without JavaScript are never visible.
 *
 * This stylesheet only exists inside `<noscript>`, i.e. only when scripting
 * is off. It hides the skeletons (the element right after each `B:n`
 * placeholder template, and a `<main>` that holds nothing but one), shows the
 * streamed `S:n` blocks in document order, and moves the footer below them.
 * A nested boundary's content (a chart streamed inside a page) lands after
 * the page body rather than in place; that is the best plain CSS can do, and
 * everything is readable and every link and form works. On a phone it also
 * shows every table's "swipe for more columns" hint, which ScrollX would
 * otherwise reveal once it had measured an overflow.
 *
 * The rules sit in Tailwind's `base` layer on purpose: preflight sets
 * `[hidden] { display: none !important }` there, and for `!important` a
 * layered rule beats any unlayered one, however specific. Inside the same
 * layer the more specific selector here wins.
 *
 * It keys on React's streaming markup (`template#B:n`, `div[hidden]#S:n`).
 * e2e/interactions.spec.ts "without JavaScript" fails if a React/Next upgrade
 * changes that markup.
 */
const NO_SCRIPT_CSS = `
@layer base {
main:has(> template[id^="B:"]) { display: none !important; }
template[id^="B:"] + * { display: none !important; }
body { display: flex; flex-direction: column; }
body > footer { order: 1; }
body > div[hidden][id^="S:"] {
  display: block !important;
  width: 100%;
  max-width: 67.5rem;
  margin-inline: auto;
  padding: 1.5rem 1rem 0;
}
body > div[hidden][id^="S:"]:has(> template[id^="B:"]) { padding: 0; }
body > div[hidden][id^="S:"]:last-of-type { padding-bottom: 5rem; }
body > div[id^="S:"] > .space-y-8 > :not(:last-child) { margin-block-end: 32px; }
@media (max-width: 639px) {
  .scroll-hint { display: flex !important; }
}
@media (min-width: 640px) {
  body > div[hidden][id^="S:"] { padding-inline: 1.5rem; padding-top: 3rem; }
  body > div[id^="S:"] > .space-y-8 > :not(:last-child) { margin-block-end: 48px; }
}
}
`;

export function NoScriptStyles() {
  return (
    <noscript>
      <style dangerouslySetInnerHTML={{ __html: NO_SCRIPT_CSS }} />
    </noscript>
  );
}
