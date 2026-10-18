/**
 * Machine-readable twins of a page, as <link> hints an agent can follow
 * instead of scraping HTML. React 19 hoists <link> elements into <head>
 * from wherever they render, so a page adds this with one line and no
 * metadata plumbing. The URLs point into /api/v1 (keyed by Bioguide ID or
 * symbol), which does not move when the page URLs do.
 *
 * `member` / `ticker` name an entity's JSON and Markdown views; `site` adds
 * the site-wide discovery links: the API's description (RFC 8631
 * `service-desc`) and its RFC 9727 catalog.
 */
export function AgentAlternates({
  member,
  ticker,
  markdown,
  json,
  text,
  site,
}: {
  /** A Bioguide ID; nothing is linked for a filer the roster did not match. */
  member?: string | null;
  ticker?: string | null;
  markdown?: string;
  json?: string;
  text?: string;
  site?: boolean;
}) {
  if (member) {
    json = `/api/v1/members/${encodeURIComponent(member)}`;
    markdown = `${json}.md`;
  } else if (ticker) {
    json = `/api/v1/tickers/${encodeURIComponent(ticker)}`;
    markdown = `${json}.md`;
  }
  return (
    <>
      {markdown ? <link rel="alternate" type="text/markdown" href={markdown} /> : null}
      {json ? <link rel="alternate" type="application/json" href={json} /> : null}
      {text ? <link rel="alternate" type="text/plain" href={text} /> : null}
      {site ? (
        <>
          <link rel="service-desc" type="application/json" href="/openapi.json" />
          <link rel="api-catalog" href="/.well-known/api-catalog" />
        </>
      ) : null}
    </>
  );
}
