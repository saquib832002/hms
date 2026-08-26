'use client';

import { useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/primitives';
import { Sheet } from '@/components/ui/sheet';
import { ROLE_LABEL } from '@/lib/nav';
import type { StaffUser, UserRole } from '@/lib/types';

const ALL_ROLES: UserRole[] = [
  'DOCTOR',
  'NURSE',
  'RECEPTIONIST',
  'PHARMACIST',
  'BILLING_STAFF',
  'ADMIN',
];

/**
 * Grant a person several roles.
 *
 * The owner-doctor case: one login for a human who both owns the hospital and
 * treats patients. They still act as ONE role at a time and switch explicitly —
 * this screen decides what they may switch *to*, not what they can do at once.
 *
 * That distinction is worth stating on the screen, because "give them admin and
 * doctor" sounds like it should merge the two menus, and merging them is exactly
 * what would give a management account clinical access.
 */
export function RolesSheet({
  user,
  onClose,
  onSaved,
}: {
  user: StaffUser | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [selected, setSelected] = useState<UserRole[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!user) return null;
  const roles = selected ?? user.roles;

  function toggle(role: UserRole) {
    setError(null);
    setSelected(
      roles.includes(role) ? roles.filter((r) => r !== role) : [...roles, role],
    );
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api(`/users/${user!.id}/roles`, { method: 'PATCH', body: { roles } });
      setSelected(null);
      onSaved();
      onClose();
    } catch (e) {
      // The server explains why: the last administrator, a doctor with no
      // profile, or an empty set.
      setError(e instanceof ApiError ? e.message : 'Could not save roles');
    } finally {
      setBusy(false);
    }
  }

  const changed =
    roles.length !== user.roles.length || roles.some((r) => !user.roles.includes(r));

  return (
    <Sheet open onClose={onClose} title={`Roles — ${user.fullName}`}>
      <p className="text-sm text-text-subtle">
        Choose every role this person may act as. They act as <strong>one at a time</strong>{' '}
        and switch from the sidebar; holding two roles never combines their access.
      </p>

      <div className="mt-4 space-y-1.5">
        {ALL_ROLES.map((role) => {
          const on = roles.includes(role);
          const isDefault = role === user.role;
          return (
            <label
              key={role}
              className={`flex cursor-pointer items-center gap-2.5 rounded-md border px-3 py-2 text-sm ${
                on ? 'border-primary bg-primary-soft' : 'border-border bg-surface'
              }`}
            >
              <input
                type="checkbox"
                checked={on}
                disabled={busy}
                onChange={() => toggle(role)}
                className="h-4 w-4"
              />
              <span className="flex-1">{ROLE_LABEL[role]}</span>
              {isDefault ? (
                <span className="rounded-full bg-[#eef0f2] px-2 py-0.5 text-xxs font-semibold text-text-muted">
                  signs in as
                </span>
              ) : null}
              {role === 'ADMIN' ? (
                <span className="text-xxs text-text-muted">no patient access</span>
              ) : null}
            </label>
          );
        })}
      </div>

      {roles.length === 0 ? (
        <p className="mt-3 text-sm text-danger">
          A user must keep at least one role. Deactivate the account instead.
        </p>
      ) : null}

      {error ? <p className="mt-3 text-sm text-danger">{error}</p> : null}

      <div className="mt-5 flex gap-2">
        <Button
          variant="primary"
          disabled={!changed || roles.length === 0 || busy}
          onClick={() => void save()}
        >
          {busy ? 'Saving…' : 'Save roles'}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
      </div>
    </Sheet>
  );
}
