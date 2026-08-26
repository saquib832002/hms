'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useUser } from '@/lib/auth-context';
import type { DepartmentRow, StaffUser, UserRole } from '@/lib/types';
import { dateTime, titleCase } from '@/lib/format';
import {
  Button,
  ErrorState,
  Field,
  Input,
  Select,
  TableSkeleton,
} from '@/components/ui/primitives';
import { Sheet } from '@/components/ui/sheet';
import { RolesSheet } from '@/components/roles-sheet';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';

const ROLES: UserRole[] = ['ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST', 'PHARMACIST', 'BILLING_STAFF'];

/**
 * Staff accounts.
 *
 * There is no delete. Audit rows reference users, and deleting one turns every
 * historical entry into "unknown", which is the opposite of an audit trail.
 * Accounts are deactivated, which also revokes their sessions immediately —
 * otherwise "deactivate" would be a suggestion for up to seven days.
 */
export default function UsersPage() {
  const [editingRoles, setEditingRoles] = useState<StaffUser | null>(null);
  const me = useUser();
  const [users, setUsers] = useState<StaffUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [resetting, setResetting] = useState<StaffUser | null>(null);
  const [credential, setCredential] = useState<{ email: string; password: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api<{ data: StaffUser[] }>('/users');
      setUsers(res.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load users');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function setActive(user: StaffUser, isActive: boolean) {
    setError(null);
    try {
      await api(`/users/${user.id}`, { method: 'PATCH', body: { isActive } });
      await load();
    } catch (err) {
      // The safety rules return 403 with the reason — self-deactivation, or the
      // last remaining admin. Show it verbatim; it is more useful than a guess.
      setError(err instanceof ApiError ? err.message : 'Could not update that account');
    }
  }

  async function setRole(user: StaffUser, role: UserRole) {
    setError(null);
    try {
      await api(`/users/${user.id}`, { method: 'PATCH', body: { role } });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not change that role');
    }
  }

  async function confirmReset() {
    if (!resetting) return;
    setBusy(true);
    try {
      const res = await api<{ temporaryPassword: string }>(`/users/${resetting.id}/reset-password`, {
        method: 'POST',
      });
      setCredential({ email: resetting.email, password: res.temporaryPassword });
      setResetting(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reset that password');
      setResetting(null);
    } finally {
      setBusy(false);
    }
  }

  if (error && !users) return <ErrorState message={error} onRetry={() => void load()} />;

  return (
    <>
      <div className="flex shrink-0 items-center gap-5 border-b border-border bg-surface px-4 py-2">
        <span className="text-xs text-text-muted">
          {users?.filter((u) => u.isActive).length ?? 0} active of {users?.length ?? 0}
        </span>
        <Button variant="primary" className="ml-auto" onClick={() => setCreating(true)}>
          Add staff account
        </Button>
      </div>

      {error && users && (
        <div
          role="alert"
          className="shrink-0 border-b border-[#f2c4be] bg-danger-soft px-4 py-2 text-sm text-[#8a2a1f]"
        >
          {error}
        </div>
      )}

      <div className="scroll-thin flex-1 overflow-y-auto bg-surface">
        {!users && <TableSkeleton cols={6} />}
        {users && (
          <table className="w-full border-collapse">
            <thead>
              <tr>
                {['Name', 'Email', 'Role', 'Last sign-in', 'Status', ''].map((h) => (
                  <th
                    key={h}
                    className="sticky top-0 border-b border-border bg-surface px-3 py-2 text-left text-xxs font-semibold uppercase tracking-wider text-text-subtle"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const isMe = u.id === me.userId;
                return (
                  <tr key={u.id} className={u.isActive ? 'hover:bg-[#fafbfc]' : 'text-text-subtle'}>
                    <td className="border-b border-[#f0f2f4] px-3 py-2 font-medium">
                      {u.fullName}
                      {isMe && (
                        <span className="ml-1.5 rounded-sm border border-border px-1 text-xxs text-text-muted">
                          you
                        </span>
                      )}
                      {u.doctor && (
                        <div className="text-xs text-text-muted">
                          {u.doctor.specialization}
                          {u.doctor.department ? ` · ${u.doctor.department}` : ''}
                        </div>
                      )}
                    </td>
                    <td className="border-b border-[#f0f2f4] px-3 py-2 font-mono text-xs">{u.email}</td>
                    <td className="border-b border-[#f0f2f4] px-3 py-2">
                      <Select
                        value={u.role}
                        // Changing your own role is refused server-side; disabling
                        // it here saves the round trip and the error.
                        disabled={isMe}
                        onChange={(e) => void setRole(u, e.target.value as UserRole)}
                        className="w-auto text-xs"
                      >
                        {ROLES.map((r) => (
                          <option key={r} value={r}>
                            {titleCase(r)}
                          </option>
                        ))}
                      </Select>
                      {/* What they may switch to. The default role alone is
                          misleading for an owner-doctor. */}
                      {u.roles && u.roles.length > 1 ? (
                        <div className="mt-1 text-xxs text-text-muted">
                          also: {u.roles.filter((r) => r !== u.role).map(titleCase).join(', ')}
                        </div>
                      ) : null}
                    </td>
                    <td className="border-b border-[#f0f2f4] px-3 py-2 font-mono text-xs text-text-muted">
                      {u.lastLoginAt ? dateTime(u.lastLoginAt) : 'never'}
                    </td>
                    <td className="border-b border-[#f0f2f4] px-3 py-2">
                      {!u.isActive ? (
                        <span className="rounded-full bg-[#eef0f2] px-2 py-0.5 text-xxs font-semibold text-text-muted">
                          Deactivated
                        </span>
                      ) : u.lockedUntil && new Date(u.lockedUntil) > new Date() ? (
                        <span className="rounded-full bg-warning-soft px-2 py-0.5 text-xxs font-semibold text-warning">
                          Locked out
                        </span>
                      ) : u.mustChangePassword ? (
                        <span className="rounded-full bg-primary-soft px-2 py-0.5 text-xxs font-semibold text-primary">
                          Password pending
                        </span>
                      ) : (
                        <span className="rounded-full bg-success-soft px-2 py-0.5 text-xxs font-semibold text-success">
                          Active
                        </span>
                      )}
                    </td>
                    <td className="border-b border-[#f0f2f4] px-3 py-2 text-right">
                      <div className="flex justify-end gap-1.5">
                        <Button size="sm" onClick={() => setEditingRoles(u)}>
                          Roles
                        </Button>
                        <Button size="sm" onClick={() => setResetting(u)}>
                          Reset password
                        </Button>
                        {u.isActive ? (
                          <Button
                            size="sm"
                            variant="danger"
                            disabled={isMe}
                            onClick={() => void setActive(u, false)}
                          >
                            Deactivate
                          </Button>
                        ) : (
                          <Button size="sm" onClick={() => void setActive(u, true)}>
                            Reactivate
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <CreateUserSheet
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(cred) => {
          setCreating(false);
          setCredential(cred);
          void load();
        }}
      />

      <ConfirmDialog
        open={resetting !== null}
        title="Reset this password?"
        consequence={
          resetting
            ? `${resetting.fullName} will be signed out everywhere and must set a new password at their next sign-in. You will be shown a temporary password once.`
            : ''
        }
        confirmLabel="Reset password"
        busy={busy}
        onConfirm={() => void confirmReset()}
        onCancel={() => setResetting(null)}
      />

      {credential && (
        <CredentialSheet credential={credential} onClose={() => setCredential(null)} />
      )}

      {/* Its own sibling, not nested in the credential branch — it opens from
          the Roles button and has nothing to do with a temporary password. */}
      <RolesSheet
        user={editingRoles}
        onClose={() => setEditingRoles(null)}
        onSaved={() => void load()}
      />
    </>
  );
}

/**
 * The temporary password, shown once.
 *
 * Not stored in plaintext and not retrievable. If it is lost before it reaches
 * the person, resetting is cheap — which is a better trade than keeping a
 * readable credential in the database so this screen can show it again.
 */
function CredentialSheet({
  credential,
  onClose,
}: {
  credential: { email: string; password: string };
  onClose: () => void;
}) {
  return (
    <Sheet
      open
      onClose={onClose}
      title="Temporary password"
      footer={
        <Button variant="primary" onClick={onClose}>
          I have passed this on
        </Button>
      }
    >
      <div className="rounded-sm border border-[#ecdca6] bg-warning-soft px-3 py-2.5 text-sm text-[#6b5314]">
        <strong>Shown once.</strong> This is not stored anywhere and cannot be shown again. If it is
        lost, reset the password — that is cheap.
      </div>

      <div className="mt-3 rounded border border-border bg-bg p-3">
        <div className="text-xxs uppercase tracking-wider text-text-muted">Email</div>
        <div className="mb-2 font-mono text-sm">{credential.email}</div>
        <div className="text-xxs uppercase tracking-wider text-text-muted">Temporary password</div>
        {/* Grouped and free of look-alike characters, because this gets read
            aloud across a desk. */}
        <div className="select-all font-mono text-xl font-bold tracking-wide">
          {credential.password}
        </div>
      </div>

      <p className="mt-3 text-xs text-text-muted">
        They will be required to set their own password before they can use the system.
      </p>
    </Sheet>
  );
}

function CreateUserSheet({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (credential: { email: string; password: string }) => void;
}) {
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<UserRole>('NURSE');
  const [specialization, setSpecialization] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [registrationNo, setRegistrationNo] = useState('');
  const [departments, setDepartments] = useState<DepartmentRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) {
      setFullName('');
      setEmail('');
      setRole('NURSE');
      setSpecialization('');
      setDepartmentId('');
      setRegistrationNo('');
      setError(null);
      return;
    }
    api<{ data: DepartmentRow[] }>('/departments')
      .then((r) => setDepartments(r.data))
      .catch(() => setDepartments([]));
  }, [open]);

  const isDoctor = role === 'DOCTOR';
  const valid =
    fullName.trim().length >= 2 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) &&
    (!isDoctor || specialization.trim().length >= 2);

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await api<{ email: string; temporaryPassword: string }>('/users', {
        method: 'POST',
        body: {
          fullName: fullName.trim(),
          email: email.trim(),
          role,
          ...(isDoctor
            ? {
                specialization: specialization.trim(),
                departmentId: departmentId ? Number(departmentId) : undefined,
                registrationNo: registrationNo.trim() || undefined,
              }
            : {}),
        },
      });
      onCreated({ email: res.email, password: res.temporaryPassword });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create that account');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Add a staff account"
      footer={
        <>
          <Button variant="primary" disabled={!valid || submitting} onClick={() => void submit()}>
            {submitting ? 'Creating…' : 'Create account'}
          </Button>
          <Button onClick={onClose}>Cancel</Button>
        </>
      }
    >
      <Field label="Full name" required>
        <Input value={fullName} onChange={(e) => setFullName(e.target.value)} autoFocus />
      </Field>
      <Field label="Email" required hint="Used to sign in.">
        <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      </Field>
      <Field label="Role" required>
        <Select value={role} onChange={(e) => setRole(e.target.value as UserRole)}>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {titleCase(r)}
            </option>
          ))}
        </Select>
      </Field>

      {isDoctor && (
        <>
          <Field
            label="Specialization"
            required
            hint="A doctor needs a profile before they can hold a clinic — appointments are booked against it."
          >
            <Input value={specialization} onChange={(e) => setSpecialization(e.target.value)} />
          </Field>
          <Field label="Department">
            <Select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
              <option value="">Unassigned</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Registration number" hint="Printed on prescriptions.">
            <Input value={registrationNo} onChange={(e) => setRegistrationNo(e.target.value)} />
          </Field>
        </>
      )}

      <p className="mt-2 text-xs text-text-muted">
        A temporary password is generated and shown once. They must set their own before using the
        system.
      </p>

      {error && (
        <div
          role="alert"
          className="mt-3 rounded-sm border border-[#f2c4be] bg-danger-soft px-2.5 py-2 text-sm text-[#8a2a1f]"
        >
          {error}
        </div>
      )}
    </Sheet>
  );
}
