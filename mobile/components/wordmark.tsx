import { StyleProp, Text, TextStyle } from 'react-native';
import { theme } from '@/lib/theme';
import { BRAND_PARTS } from '@/lib/types';

/**
 * The product wordmark: `One` blue, `Care` near-black, `HMS` the brand red.
 *
 * The mobile half of `web/components/ui/wordmark.tsx`. The markup cannot be
 * shared — `<Text>` against `<span>` — but the words and the split points are
 * read from `types.ts`, which is duplicated byte-for-byte between the clients
 * with a drift test, so the two cannot disagree about where `One` ends.
 *
 * The spacing is asymmetric on purpose: `One` and `Care` are one word and
 * `HMS` is a separate one, so this is `OneCare HMS` and never `One Care HMS`.
 *
 * The colours are `brandOne` / `brandCare` / `brandHms` rather than the
 * semantic tokens, and on this client that matters more than on the web: the
 * phone's `primary` is derived from the signed-in **role**, so a wordmark
 * pointed at it would change colour depending on who was logged in. `brandHms`
 * is also not `danger` — see the notes in `lib/theme.ts`. `brand.spec.ts`
 * asserts all three equal the web values, because one set of colours on a
 * desktop and another on a phone is drift nobody notices until the two are
 * side by side.
 *
 * Used only before sign-in. Once there is a session `AppHeader` names the
 * **hospital**, read off that session, and `tenant-chrome.spec.ts` fails the
 * build on a hard-coded name there — a safety control, not branding, because
 * one address can exist at two hospitals and being signed into the wrong one
 * is a reachable state.
 */
export default function Wordmark({ style }: { style?: StyleProp<TextStyle> }) {
  const [one, care, suffix] = BRAND_PARTS;
  return (
    <Text style={style}>
      <Text style={{ color: theme.color.brandOne }}>{one}</Text>
      <Text style={{ color: theme.color.brandCare }}>{care}</Text>{' '}
      <Text style={{ color: theme.color.brandHms }}>{suffix}</Text>
    </Text>
  );
}
