import { SkipLink, ThemeTransition } from "./a11y";

/**
 * Wraps every page (and its loading, error and not-found states) with the
 * page-wide accessibility and motion hooks in app/a11y.tsx. Renders no
 * element of its own, so `main > *` is still the page's root.
 */
export default function Template({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SkipLink />
      <ThemeTransition />
      {children}
    </>
  );
}
