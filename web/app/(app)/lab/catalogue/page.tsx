'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import type { LabTest } from '@/lib/types';
import { titleCase } from '@/lib/format';
import {
  Button,
  EmptyState,
  ErrorState,
  Input,
  TableSkeleton,
} from '@/components/ui/primitives';

/**
 * The catalogue, as the laboratory sees it.
 *
 * Read-only except for one thing: the price. That is not a permission
 * inconsistency, it is the fix for a dead end the pharmacy already found —
 * "not priced" on the dispensing screen sent the pharmacist to a settings
 * screen with a patient at the counter, and in practice the medicine went out
 * unpriced and the loss surfaced a month later in a report.
 *
 * Everything else about a test — its reference ranges, its analytes, whether it
 * is offered at all — is configuration an administrator sets once at a desk,
 * and belongs on the admin screen with the rest of it.
 *
 * Unpriced tests are listed first, because that is the only thing on this
 * screen anybody has to act on.
 */
export default function LabCataloguePage() {
  const [tests, setTests] = useState<LabTest[] | null>(null);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<number | null>(null);
  const [price, setPrice] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api<{ data: LabTest[] }>('/lab-tests');
      setTests(res.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the catalogue');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function savePrice(id: number) {
    setBusy(true);
    setError(null);
    try {
      await api(`/lab-tests/${id}`, { method: 'PATCH', body: { sellingPrice: price.trim() } });
      setEditing(null);
      setPrice('');
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not set that price');
    } finally {
      setBusy(false);
    }
  }

  if (error && !tests) return <ErrorState message={error} onRetry={() => void load()} />;

  const q = query.trim().toLowerCase();
  const filtered = (tests ?? []).filter(
    (t) => !q || t.name.toLowerCase().includes(q) || t.code.toLowerCase().includes(q),
  );
  // Unpriced first — the only actionable thing on this screen.
  const rows = [...filtered].sort((a, b) => {
    const ap = a.sellingPrice === null ? 0 : 1;
    const bp = b.sellingPrice === null ? 0 : 1;
    return ap - bp || a.name.localeCompare(b.name);
  });
  const unpriced = (tests ?? []).filter((t) => t.sellingPrice === null).length;

  return (
    <div className="scroll-thin flex-1 overflow-y-auto p-4">
      <div className="mb-3">
        <h1 className="text-lg font-semibold text-text">Test catalogue</h1>
        <p className="text-sm text-text-muted">
          What this laboratory offers. Ranges and analytes are set by an administrator under{' '}
          <strong>Lab Tests</strong>; you can fix a missing price here.
        </p>
      </div>

      {unpriced > 0 && (
        /* Blank is not zero. An unpriced test is performed and not charged for,
           which is a decision nobody made. */
        <div className="mb-3 rounded-sm border border-[#ecdca6] bg-warning-soft px-3 py-2 text-sm text-[#6b5314]">
          <strong>
            {unpriced} test{unpriced === 1 ? '' : 's'} with no price.
          </strong>{' '}
          These are still performed and simply not billed for.
        </div>
      )}

      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search by name or code…"
        className="mb-3 max-w-md"
      />

      {error && <p className="mb-3 text-sm text-danger">{error}</p>}

      {!tests ? (
        <TableSkeleton rows={6} />
      ) : rows.length === 0 ? (
        <EmptyState
          title={tests.length === 0 ? 'No tests yet' : 'Nothing matches'}
          description={
            tests.length === 0
              ? 'An administrator adds tests under Lab Tests — code, name, price and reference ranges. Until then doctors have nothing to request.'
              : 'Try a different search.'
          }
        />
      ) : (
        <div className="overflow-hidden rounded-md border border-border">
          <table className="w-full text-sm">
            <thead className="bg-bg text-left text-xs uppercase text-text-subtle">
              <tr>
                <th className="px-3 py-2">Code</th>
                <th className="px-3 py-2">Test</th>
                <th className="px-3 py-2">Category</th>
                <th className="px-3 py-2">Specimen</th>
                <th className="px-3 py-2">Analytes</th>
                <th className="px-3 py-2 text-right">Price</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id} className="border-t border-border align-top">
                  <td className="px-3 py-2 font-mono text-xs">{t.code}</td>
                  <td className="px-3 py-2">
                    <div className="font-medium">{t.name}</div>
                    {t.preparation && (
                      <div className="text-xs text-text-muted">{t.preparation}</div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-text-muted">{titleCase(t.category)}</td>
                  <td className="px-3 py-2 text-xs text-text-muted">
                    {t.specimenType === 'NONE' ? '—' : titleCase(t.specimenType)}
                  </td>
                  <td className="px-3 py-2 text-xs text-text-muted">
                    {t.analytes.length === 0 ? 'narrative only' : t.analytes.length}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {editing === t.id ? (
                      <div className="flex justify-end gap-1.5">
                        <Input
                          value={price}
                          onChange={(e) => setPrice(e.target.value)}
                          placeholder="0.00"
                          className="max-w-24 text-right"
                        />
                        <Button disabled={busy || !price.trim()} onClick={() => void savePrice(t.id)}>
                          Save
                        </Button>
                      </div>
                    ) : (
                      <button
                        onClick={() => {
                          setEditing(t.id);
                          setPrice(t.sellingPrice ?? '');
                        }}
                        className="text-xs text-primary hover:underline"
                      >
                        {/* Never "0.00" for an unpriced test. The two mean
                            different things and only one of them is a decision. */}
                        {t.sellingPrice ?? 'Not priced'}
                      </button>
                    )}
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
