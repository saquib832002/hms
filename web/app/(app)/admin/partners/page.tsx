'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import type { PharmacyPartner } from '@/lib/types';
import { date } from '@/lib/format';
import {
  Button,
  EmptyState,
  ErrorState,
  Field,
  Input,
  TableSkeleton,
} from '@/components/ui/primitives';

/**
 * Pharmacies at other hospitals that this one may send prescriptions to.
 *
 * WHY THERE IS NO LIST TO PICK FROM
 * ---------------------------------
 * The obvious design is a dropdown of every hospital on the platform that runs
 * a pharmacy. It is a trap: that list is the provider's customer base, and
 * making it browsable by every administrator turns a feature into a
 * competitor-research tool. The public signup form refuses to say whether an
 * email has applied before for exactly the same reason.
 *
 * So partnerships start offline. Two businesses agree to work together, one
 * passes over a short code, and the other types it here. The lookup answers
 * only for hospitals that have switched on "accept prescriptions from other
 * hospitals" at their end — and gives the same answer for "no such code",
 * "they have no pharmacy" and "they have not switched it on", so it cannot be
 * used to probe.
 */
export default function PartnersPage() {
  const [rows, setRows] = useState<PharmacyPartner[] | null>(null);
  const [slug, setSlug] = useState('');
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api<{ data: PharmacyPartner[] }>('/pharmacy-partners');
      setRows(res.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load partners');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function add() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api('/pharmacy-partners', {
        method: 'POST',
        body: { slug: slug.trim().toLowerCase(), label: label.trim() },
      });
      setSlug('');
      setLabel('');
      setNotice('Added. Doctors can now send prescriptions there.');
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not add that pharmacy');
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: number, name: string) {
    /*
     * One click with no undo on screen, so it asks. The row is deactivated
     * rather than deleted — prescriptions already sent there have to keep
     * resolving — and the wording says it can be added back, because the
     * silent version of this sent somebody into a dead end: removed, then
     * refused on re-add as "already a partner", about a row the list does not
     * show.
     */
    if (!confirm(`Stop sending prescriptions to ${name}? You can add them back with the same code.`))
      return;
    try {
      await api(`/pharmacy-partners/${id}`, { method: 'DELETE' });
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not remove that partner');
    }
  }

  if (error && !rows) return <ErrorState message={error} onRetry={() => void load()} />;

  return (
    <div className="scroll-thin flex-1 overflow-y-auto p-4">
      <div className="mb-4">
        <h1 className="text-lg font-semibold text-text">Partner pharmacies</h1>
        <p className="text-sm text-text-muted">
          Where your doctors may send a prescription instead of your own pharmacy.
        </p>
      </div>

      <div className="mb-5 max-w-lg rounded-md border border-border bg-surface p-4">
        <p className="mb-3 text-sm text-text-muted">
          Ask the pharmacy for their code. They have to switch on{' '}
          <strong>accept prescriptions from other hospitals</strong> in their own settings before
          you can add them.
        </p>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Their code" required>
            <Input
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder="st-marys"
              className="font-mono"
            />
          </Field>
          <Field label="What you call them" required hint="Shown in the doctor's list.">
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="St Mary's, MG Road"
            />
          </Field>
        </div>

        {error && <p className="mt-2 text-sm text-danger">{error}</p>}
        {notice && <p className="mt-2 text-sm text-success">{notice}</p>}

        <Button
          variant="primary"
          className="mt-3"
          disabled={busy || slug.trim().length < 2 || label.trim().length < 2}
          onClick={() => void add()}
        >
          {busy ? 'Adding…' : 'Add partner'}
        </Button>
      </div>

      {!rows ? (
        <TableSkeleton rows={3} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No partner pharmacies"
          description="Until you add one, your doctors can send a prescription to your own pharmacy or hand it to the patient."
        />
      ) : (
        <div className="overflow-hidden rounded-md border border-border">
          <table className="w-full text-sm">
            <thead className="bg-bg text-left text-xs uppercase text-text-subtle">
              <tr>
                <th className="px-3 py-2">Pharmacy</th>
                <th className="px-3 py-2">Added</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id} className="border-t border-border">
                  <td className="px-3 py-2 font-medium">{p.label}</td>
                  <td className="px-3 py-2 text-xs text-text-muted">{date(p.createdAt)}</td>
                  <td className="px-3 py-2 text-right">
                    {/* Deactivated, not deleted. Prescriptions already sent
                        there record where they went, and a partner row that
                        vanished leaves those pointing at nothing. Re-adding
                        the same code reactivates this row. */}
                    <button
                      onClick={() => void remove(p.id, p.label)}
                      className="text-xs text-danger hover:underline"
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
