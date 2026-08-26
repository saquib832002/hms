'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { Doctor } from '@/lib/types';
import { EmptyState, ErrorState, TableSkeleton } from '@/components/ui/primitives';

export default function DoctorsPage() {
  const [doctors, setDoctors] = useState<Doctor[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Doctor[]>('/doctors')
      .then(setDoctors)
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load doctors'));
  }, []);

  if (error) return <ErrorState message={error} />;

  return (
    <div className="scroll-thin flex-1 overflow-y-auto bg-surface">
      {!doctors && <TableSkeleton cols={4} />}
      {doctors?.length === 0 && <EmptyState title="No doctors registered" />}
      {doctors && doctors.length > 0 && (
        <table className="w-full border-collapse">
          <thead>
            <tr>
              {['Name', 'Specialization', 'Department', 'Reg. no'].map((h) => (
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
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
