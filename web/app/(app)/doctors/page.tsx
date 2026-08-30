'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { useMoney } from '@/lib/use-money';
import type { Doctor } from '@/lib/types';
import { Button, EmptyState, ErrorState, Input, TableSkeleton } from '@/components/ui/primitives';

/**
 * The doctor directory, and where an administrator sets a consultation fee.
 *
 * WHY THE FEE EDITOR IS HERE
 * --------------------------
 * `PATCH /doctors/:id` existed, was tested, and had no caller — it sat in
 * `KNOWN_GAPS` as "an admin can create a doctor account but cannot edit the
 * profile", which was tolerable while a doctor profile was only descriptive.
 * Adding a consultation fee made it load-bearing: reception's checkout refuses
 * to bill a doctor with no fee, so a fee nobody can set is a checkout nobody
 * can complete.
 *
 * NO FEE AND A ZERO FEE ARE DIFFERENT
 * -----------------------------------
 * Blank means "not set" and checkout refuses, naming the doctor. Zero means the
 * consultation is genuinely free and bills as such. Collapsing the two would
 * make a forgotten price look like a decision, and the first anyone would know
 * is a month of unbilled consultations.
 */
export default function DoctorsPage() {
  const { user } = useAuth();
  const money = useMoney();
  const isAdmin = user?.role === 'ADMIN';

  const [doctors, setDoctors] = useState<Doctor[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [fee, setFee] = useState('');
  const [saving, setSaving] = useState(false);

  function load() {
    api<Doctor[]>('/doctors')
      .then(setDoctors)
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load doctors'));
  }

  useEffect(load, []);

  async function saveFee(id: number) {
    const value = fee.trim();
    if (value !== '' && !/^\d{1,8}(\.\d{1,2})?$/.test(value)) {
      setError('Fee must be an amount like 500 or 500.00, or blank to clear it.');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      // Sent as a string, like every amount in this system. A JSON number has
      // already been through float representation by the time it lands.
      await api(`/doctors/${id}`, { method: 'PATCH', body: { consultationFee: value } });
      setEditing(null);
      setFee('');
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the fee');
    } finally {
      setSaving(false);
    }
  }

  if (error && !doctors) return <ErrorState message={error} />;

  const columns = ['Name', 'Specialization', 'Department', 'Reg. no', 'Consultation fee'];

  return (
    <div className="scroll-thin flex-1 overflow-y-auto bg-surface">
      {error && doctors && (
        <div className="border-b border-danger-soft bg-danger-soft px-3 py-2 text-xs text-danger">
          {error}
        </div>
      )}

      {!doctors && <TableSkeleton cols={5} />}
      {doctors?.length === 0 && <EmptyState title="No doctors registered" />}

      {doctors && doctors.length > 0 && (
        <table className="w-full border-collapse">
          <thead>
            <tr>
              {columns.map((h) => (
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
            {doctors.map((d) => (
              <tr key={d.id} className="hover:bg-[#fafbfc]">
                <td className="border-b border-[#f0f2f4] px-3 py-2 font-medium">{d.fullName}</td>
                <td className="border-b border-[#f0f2f4] px-3 py-2">{d.specialization}</td>
                <td className="border-b border-[#f0f2f4] px-3 py-2 text-text-muted">
                  {d.department?.name ?? '—'}
                </td>
                <td className="border-b border-[#f0f2f4] px-3 py-2 font-mono text-xs text-text-muted">
                  {d.registrationNo ?? '—'}
                </td>
                <td className="border-b border-[#f0f2f4] px-3 py-2">
                  {editing === d.id ? (
                    <div className="flex items-center gap-2">
                      <Input
                        autoFocus
                        value={fee}
                        onChange={(e) => setFee(e.target.value)}
                        placeholder="blank = not set"
                        className="w-28"
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void saveFee(d.id);
                          if (e.key === 'Escape') setEditing(null);
                        }}
                      />
                      <Button onClick={() => void saveFee(d.id)} disabled={saving}>
                        Save
                      </Button>
                      <Button variant="ghost" onClick={() => setEditing(null)}>
                        Cancel
                      </Button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-3">
                      <span className={d.consultationFee ? '' : 'text-warning'}>
                        {d.consultationFee ? money(d.consultationFee) : 'Not set'}
                      </span>
                      {isAdmin && (
                        <button
                          onClick={() => {
                            setEditing(d.id);
                            setFee(d.consultationFee ?? '');
                          }}
                          className="text-xs text-primary hover:underline"
                        >
                          Edit
                        </button>
                      )}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
