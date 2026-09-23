'use client';

import { useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { Button, Field, Input } from '@/components/ui/primitives';
import { Sheet } from '@/components/ui/sheet';
import { ROLE_LABEL } from '@/lib/nav';
import type { StaffUser, UserRole } from '@/lib/types';

/*
 * The role list arrives narrowed to the hospital's modules — see the note on
 * `ROLE_LABEL` in `lib/nav.ts`. It is never retyped here: the hand-written
 * version of this array omitted LAB_TECHNICIAN, so the role existed everywhere
 * except in the one place it could be granted.
 */

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
  offerable,
  user,
  onClose,
  onSaved,
}: {
  /** The roles this hospital may grant at all — narrowed to its modules. */
  offerable: UserRole[];
  user: StaffUser | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [selected, setSelected] = useState<UserRole[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /*
   * The clinical half, asked for only when it is actually needed.
   *
   * A person can be given the DOCTOR role only if they have a `Doctor` profile
   * — appointments key on `Doctor.id`, so a doctor without one cannot be
   * booked. Until now the only way to create that profile was to create a whole
   * new account, which forced the owner of a clinic who is also its doctor to
   * hold two logins for one human. Asking for a specialisation here attaches
   * the profile to the account already in front of us.
   */
  const [specialization, setSpecialization] = useState('');
  const [registrationNo, setRegistrationNo] = useState('');

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
      /*
       * Profile first, then roles.
       *
       * The other order fails: the server refuses the DOCTOR role for somebody
       * with no profile, so saving roles would 400 before the profile existed.
       * Two requests rather than one because they are two different decisions —
       * "this person is a clinician" outlives any particular set of roles, and
       * folding clinical fields into the roles endpoint would make a checkbox
       * list quietly responsible for creating records.
       */
      if (needsProfile) {
        await api(`/users/${user!.id}/doctor-profile`, {
          method: 'POST',
          body: {
            specialization: specialization.trim(),
            registrationNo: registrationNo.trim() || undefined,
          },
        });
      }

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

  /** Doctor has been ticked for somebody who is not yet bookable. */
  const needsProfile = roles.includes('DOCTOR') && user.doctor === null;
  const profileReady = !needsProfile || specialization.trim().length >= 2;

  return (
    <Sheet open onClose={onClose} title={`Roles — ${user.fullName}`}>
      <p className="text-sm text-text-subtle">
        Choose every role this person may act as. They act as <strong>one at a time</strong>{' '}
        and switch from the sidebar; holding two roles never combines their access.
      </p>

      <div className="mt-4 space-y-1.5">
        {offerable.map((role) => {
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

      {needsProfile ? (
        <div className="mt-4 rounded-md border border-border bg-bg p-3">
          <p className="text-sm font-medium text-text">
            {user.fullName} is not set up as a doctor yet
          </p>
          <p className="mt-0.5 mb-3 text-xs text-text-muted">
            A doctor needs a clinical profile before they can be booked or hold a clinic. This
            attaches one to <strong>this same account</strong> — no second login, and their
            existing work stays under one name.
          </p>

          <Field
            label="Specialization"
            required
            hint="Shown wherever a doctor is chosen — on booking, and on the queue."
          >
            <Input
              value={specialization}
              onChange={(e) => setSpecialization(e.target.value)}
              placeholder="General Medicine"
              autoFocus
            />
          </Field>

          <Field label="Registration number" hint="Optional. Their medical council number.">
            <Input
              value={registrationNo}
              onChange={(e) => setRegistrationNo(e.target.value)}
            />
          </Field>

          {/* Said here because it is the next thing that will block somebody,
              and the person it blocks is a receptionist standing in front of a
              patient rather than the admin reading this. */}
          <p className="text-xs text-text-subtle">
            Set their consultation fee on the Doctors screen afterwards — checkout refuses for a
            doctor with no fee.
          </p>
        </div>
      ) : null}

      {roles.length === 0 ? (
        <p className="mt-3 text-sm text-danger">
          A user must keep at least one role. Deactivate the account instead.
        </p>
      ) : null}

      {error ? <p className="mt-3 text-sm text-danger">{error}</p> : null}

      <div className="mt-5 flex gap-2">
        <Button
          variant="primary"
          disabled={!changed || roles.length === 0 || !profileReady || busy}
          onClick={() => void save()}
        >
          {busy ? 'Saving…' : needsProfile ? 'Create profile and save roles' : 'Save roles'}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
      </div>
    </Sheet>
  );
}
