'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useAuth } from '@/lib/auth-context';
import { landingFor, ROLE_LABEL } from '@/lib/nav';
import type { UserRole } from '@/lib/types';

/**
 * Switch which of your own roles you are acting as.
 *
 * Rendered only when there is more than one — most staff hold a single role
 * and should not see a control that never does anything.
 *
 * WHY A SWITCH RATHER THAN A COMBINED MENU
 * ----------------------------------------
 * An owner who is also a doctor holds both ADMIN and DOCTOR, and acts as one
 * at a time. Merging the menus would give the administrative role clinical
 * access, which is the rule `CLAUDE.md` spends a phase enforcing. Choosing is
 * also what makes the audit trail readable: every action afterwards is
 * recorded against the role that was worn.
 */
export function RoleSwitcher() {
  const { user, switchRole } = useAuth();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const roles = user?.availableRoles ?? [];
  if (!user || roles.length < 2) return null;

  async function choose(role: UserRole) {
    if (role === user!.role || busy) return;
    setBusy(true);
    setError(null);
    try {
      await switchRole(role);
      // The current screen may not exist for the new role — an admin has no
      // clinical queue — so land on that role's own starting point rather than
      // leaving them on a page that will 403.
      router.push(landingFor(role));
    } catch {
      setError('Could not switch role');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border-t border-border px-3 py-2">
      <div className="mb-1 text-[11px] uppercase tracking-wide text-text-subtle">
        Acting as
      </div>
      <div className="flex flex-wrap gap-1">
        {roles.map((role) => {
          const active = role === user.role;
          return (
            <button
              key={role}
              type="button"
              disabled={busy}
              aria-current={active}
              onClick={() => void choose(role)}
              className={`rounded-sm border px-2 py-1 text-xs ${
                active
                  ? 'border-primary bg-primary text-white'
                  : 'border-border-strong bg-surface hover:border-primary disabled:opacity-50'
              }`}
            >
              {ROLE_LABEL[role]}
            </button>
          );
        })}
      </div>
      {error ? <p className="mt-1 text-xs text-danger">{error}</p> : null}
    </div>
  );
}
