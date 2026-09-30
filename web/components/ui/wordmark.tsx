import { BRAND_PARTS } from '@/lib/types';

/**
 * The product wordmark: `One` blue, `Care` near-black, `HMS` the brand red.
 *
 * WHY A COMPONENT RATHER THAN THE MARKUP ON EACH SCREEN
 * -----------------------------------------------------
 * There is exactly one place the three colours and the two split points are
 * decided, so a rebrand is one edit and the parts cannot drift apart between
 * screens. Before this it was retyped on the login page and again on the reset
 * page, which is two chances to change one and forget the other — and the
 * forgotten one is always the screen nobody opens on an ordinary day.
 *
 * The words come from `types.ts`, which is duplicated byte-for-byte into the
 * mobile app with a drift test, so both clients split the name identically.
 *
 * WHY THE SPACING IS ASYMMETRIC
 * -----------------------------
 * `One` and `Care` are one word; `HMS` is a separate one. So it renders as
 * `OneCare HMS` and never `One Care HMS`. Three parts joined with a single
 * separator would produce the second and look entirely plausible in a diff.
 *
 * WHY THE COLOURS ARE `brand-*` AND NOT THE SEMANTIC TOKENS
 * ---------------------------------------------------------
 * `brand-one` is the same blue as `primary` today, and that is a coincidence
 * rather than a relationship: pointing the logo at `primary` would mean
 * retuning the button blue silently restyles the mark. `brand-hms` is not
 * `danger` for a sharper version of the same reason — `danger` means "this
 * failed", and a logo sharing that token reads as a warning while real
 * warnings stop standing out. See the note in `tailwind.config.ts`.
 *
 * WHY IT SAYS THE PRODUCT AND NOT THE HOSPITAL
 * --------------------------------------------
 * This is only ever used *before* sign-in — the login screen, the reset
 * screens, the browser tab. Once a session exists the chrome names the
 * **hospital**, read off the session, and `tenant-chrome.spec.ts` fails the
 * build on a hard-coded name there. That is a safety control rather than
 * branding: one address can exist at two hospitals, so being signed into the
 * wrong one is reachable, and the cost is a note written into another
 * hospital's books.
 */
export function Wordmark({ className = '' }: { className?: string }) {
  const [one, care, suffix] = BRAND_PARTS;
  return (
    <span className={className}>
      <span className="text-brand-one">{one}</span>
      <span className="text-brand-care">{care}</span>{' '}
      <span className="text-brand-hms">{suffix}</span>
    </span>
  );
}
