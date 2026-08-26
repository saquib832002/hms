'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import type { DepartmentRow } from '@/lib/types';
import { Button, EmptyState, ErrorState, Field, Input, TableSkeleton } from '@/components/ui/primitives';
import { Sheet } from '@/components/ui/sheet';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';

export default function DepartmentsPage() {
  const [rows, setRows] = useState<DepartmentRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<DepartmentRow | 'new' | null>(null);
  const [deleting, setDeleting] = useState<DepartmentRow | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api<{ data: DepartmentRow[] }>('/departments');
      setRows(res.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load departments');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function confirmDelete() {
    if (!deleting) return;
    setBusy(true);
    try {
      await api(`/departments/${deleting.id}`, { method: 'DELETE' });
      setDeleting(null);
      await load();
    } catch (err) {
      // Refused while doctors are still assigned — the server explains why.
      setError(err instanceof ApiError ? err.message : 'Could not delete that department');
      setDeleting(null);
    } finally {
      setBusy(false);
    }
  }

  if (error && !rows) return <ErrorState message={error} onRetry={() => void load()} />;

  return (
    <>
      <div className="flex shrink-0 items-center gap-3 border-b border-border bg-surface px-4 py-2">
        <span className="text-xs text-text-muted">{rows?.length ?? 0} departments</span>
        <Button variant="primary" className="ml-auto" onClick={() => setEditing('new')}>
          Add department
        </Button>
      </div>

      {error && rows && (
        <div
          role="alert"
          className="shrink-0 border-b border-[#f2c4be] bg-danger-soft px-4 py-2 text-sm text-[#8a2a1f]"
        >
          {error}
        </div>
      )}

      <div className="scroll-thin flex-1 overflow-y-auto bg-surface">
        {!rows && <TableSkeleton cols={3} />}
        {rows?.length === 0 && <EmptyState title="No departments yet" />}

        {rows && rows.length > 0 && (
          <table className="w-full border-collapse">
            <thead>
              <tr>
                {['Department', 'Doctors', ''].map((h) => (
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
              {rows.map((d) => (
                <tr key={d.id} className="hover:bg-[#fafbfc]">
                  <td className="border-b border-[#f0f2f4] px-3 py-2 font-medium">{d.name}</td>
                  <td className="border-b border-[#f0f2f4] px-3 py-2 text-sm text-text-muted">
                    {d.doctorCount === 0
                      ? '—'
                      : d.doctors.map((doc) => doc.fullName).join(', ')}
                  </td>
                  <td className="border-b border-[#f0f2f4] px-3 py-2 text-right">
                    <div className="flex justify-end gap-1.5">
                      <Button size="sm" onClick={() => setEditing(d)}>
                        Rename
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={d.doctorCount > 0}
                        title={d.doctorCount > 0 ? 'Move the doctors out first' : undefined}
                        onClick={() => setDeleting(d)}
                      >
                        Delete
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {editing && (
        <DepartmentSheet
          department={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}

      <ConfirmDialog
        open={deleting !== null}
        title="Delete this department?"
        consequence={
          deleting
            ? `${deleting.name} will be removed. Only possible because no doctors are assigned to it.`
            : ''
        }
        confirmLabel="Delete department"
        busy={busy}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleting(null)}
      />
    </>
  );
}

function DepartmentSheet({
  department,
  onClose,
  onSaved,
}: {
  department: DepartmentRow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(department?.name ?? '');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      if (department) {
        await api(`/departments/${department.id}`, { method: 'PATCH', body: { name: name.trim() } });
      } else {
        await api('/departments', { method: 'POST', body: { name: name.trim() } });
      }
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save that department');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title={department ? 'Rename department' : 'Add department'}
      footer={
        <>
          <Button
            variant="primary"
            disabled={name.trim().length < 2 || submitting}
            onClick={() => void submit()}
          >
            {submitting ? 'Saving…' : 'Save'}
          </Button>
          <Button onClick={onClose}>Cancel</Button>
        </>
      }
    >
      <Field label="Name" required>
        <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={120} />
      </Field>
      {error && (
        <div
          role="alert"
          className="rounded-sm border border-[#f2c4be] bg-danger-soft px-2.5 py-2 text-sm text-[#8a2a1f]"
        >
          {error}
        </div>
      )}
    </Sheet>
  );
}
