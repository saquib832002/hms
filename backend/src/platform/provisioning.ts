import { BadRequestException } from '@nestjs/common';
import { isValidTimeZone } from '../common/tenancy/clinic-settings';

/**
 * Turning an application into a hospital.
 *
 * Pure, so the parts that are easy to get wrong — and invisible once wrong —
 * can be pinned without a database. A bad slug is not a crash; it is a hospital
 * whose login URL collides with another's six months later.
 */

/**
 * A URL-safe name, derived from the hospital's own.
 *
 * WHY THE APPLICANT'S REQUESTED SLUG IS ONLY A SUGGESTION
 * -------------------------------------------------------
 * `Tenant.slug` is unique and is the key that disambiguates login when one
 * email address exists at two hospitals. A public form that reserved slugs
 * could be scripted to squat every plausible hospital name, and one that
 * validated availability live would be an oracle for which hospitals already
 * exist. So the request is stored, shown to the reviewer, and applied only if
 * it is still free at approval.
 */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    // Strip accents rather than transliterating: "Sankt Görans" becoming
    // "sankt-gorans" is a fine URL, and a half-built transliteration table is
    // worse than none.
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
}

/**
 * The first free slug, appending -2, -3 … when taken.
 *
 * Not a random suffix. `st-marys-7f3a` is unguessable, unreadable and unsayable
 * over a phone — and this string is the thing a receptionist types to sign in.
 */
export function uniqueSlug(base: string, taken: Set<string>): string {
  const root = slugify(base) || 'hospital';
  if (!taken.has(root)) return root;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${root}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new BadRequestException(`Cannot derive a free slug from "${base}"`);
}

export interface ProvisionInput {
  hospitalName: string;
  slug?: string | null;
  adminEmail: string;
  adminName: string;
  timezone?: string | null;
  currency?: string | null;
}

export interface ProvisionPlan {
  name: string;
  slug: string;
  timezone: string;
  currency: string;
  adminEmail: string;
  adminName: string;
}

/**
 * Validates and normalises everything before a single row is written.
 *
 * All of it up front, because provisioning creates a tenant *and* a user *and*
 * an audit entry, and failing halfway through leaves a hospital that exists and
 * nobody can sign into. The transaction protects against a crash; this protects
 * against input the transaction would have committed happily.
 */
export function planProvision(input: ProvisionInput, takenSlugs: Set<string>): ProvisionPlan {
  const name = input.hospitalName.trim();
  if (name.length < 2) throw new BadRequestException('A hospital name is required');

  const email = input.adminEmail.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new BadRequestException('A valid administrator email is required');
  }

  const adminName = input.adminName.trim();
  if (adminName.length < 2) throw new BadRequestException("The administrator's name is required");

  /*
   * A requested slug that is already taken is refused rather than silently
   * suffixed. Somebody asked for a specific one; handing them `st-marys-2`
   * without saying so is the sort of quiet substitution nobody notices until a
   * printed sign-in card is wrong.
   *
   * When no slug was requested, deriving one and suffixing is fine: nobody has
   * an expectation to violate.
   */
  const requested = input.slug?.trim().toLowerCase();
  let slug: string;
  if (requested) {
    if (!/^[a-z0-9-]+$/.test(requested)) {
      throw new BadRequestException('A slug may contain lowercase letters, numbers and hyphens only');
    }
    if (takenSlugs.has(requested)) {
      throw new BadRequestException(`The address "${requested}" is already in use by another hospital`);
    }
    slug = requested;
  } else {
    slug = uniqueSlug(name, takenSlugs);
  }

  /*
   * Timezone is validated here and not merely defaulted.
   *
   * A hospital left on the wrong zone gets a clinic day that ends before its
   * staff arrive and a booking page offering only past slots — which presents
   * as a bug in booking rather than as a wrong setting, and is exactly the
   * failure `clinic-settings.ts` documents. Getting it right at provisioning is
   * far cheaper than diagnosing it later.
   */
  const timezone = input.timezone?.trim() || 'UTC';
  if (!isValidTimeZone(timezone)) {
    throw new BadRequestException(`"${timezone}" is not a recognised IANA timezone`);
  }

  const currency = (input.currency?.trim() || 'USD').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new BadRequestException('Currency must be a three-letter ISO 4217 code');
  }

  return { name, slug, timezone, currency, adminEmail: email, adminName };
}
