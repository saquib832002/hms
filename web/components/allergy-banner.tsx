import type { Allergy } from '@/lib/types';
import { titleCase } from '@/lib/format';

/**
 * Never collapsed, never behind a tab, on every patient view in the system.
 * The cheapest safety win in the whole UI.
 *
 * `allergies === undefined` means this role's API response does not include
 * clinical data at all (reception, billing, admin) — so render nothing. An
 * empty array means the role can see allergies and this patient has none,
 * which is worth stating explicitly rather than leaving ambiguous.
 */
export function AllergyBanner({ allergies }: { allergies?: Allergy[] }) {
  if (allergies === undefined) return null;

  if (allergies.length === 0) {
    return (
      <div className="rounded-sm border border-border bg-bg px-2.5 py-1.5 text-xs text-text-muted">
        No known allergies recorded
      </div>
    );
  }

  return (
    <div
      role="alert"
      className="rounded-sm border border-[#f2c4be] border-l-[3px] border-l-danger bg-danger-soft px-2.5 py-2 text-sm font-semibold text-[#8a2a1f]"
    >
      <span className="mr-1.5">⚠</span>
      ALLERGY —{' '}
      {allergies.map((a, i) => (
        <span key={a.id}>
          {i > 0 && ', '}
          {a.substance} ({titleCase(a.severity)})
        </span>
      ))}
    </div>
  );
}
