'use client';

import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import type { Paginated, PatientListItem } from '@/lib/types';
import { isoDate } from '@/lib/format';
import { Button, Field, Input, SectionLabel } from '@/components/ui/primitives';
import { Sheet } from '@/components/ui/sheet';
import { useMoney } from '@/lib/use-money';

interface Line {
  description: string;
  amount: string;
}

/** Common charges, so the usual invoice is a few clicks rather than typing. */
const PRESETS: Line[] = [
  { description: 'Outpatient consultation', amount: '120.00' },
  { description: 'Ward stay, per night', amount: '450.00' },
  { description: 'Diagnostic imaging', amount: '280.00' },
  { description: 'Minor procedure', amount: '640.00' },
  { description: 'Dressing and supplies', amount: '35.50' },
];

/**
 * Create an invoice.
 *
 * Line descriptions are typed or picked from service presets — never pulled
 * from what was prescribed or dispensed. "Amoxicillin 500mg × 21" on an invoice
 * line would hand billing a medication history, routing clinical data past the
 * role-shaped patient response that exists to keep it away from them.
 */
export function CreateInvoiceSheet({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const fmt = useMoney();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PatientListItem[]>([]);
  const [patient, setPatient] = useState<PatientListItem | null>(null);
  const [lines, setLines] = useState<Line[]>([{ description: '', amount: '' }]);
  const [dueDate, setDueDate] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setResults([]);
      setPatient(null);
      setLines([{ description: '', amount: '' }]);
      setDueDate('');
      setError(null);
    }
  }, [open]);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      api<Paginated<PatientListItem>>(`/patients?q=${encodeURIComponent(q)}&limit=6`)
        .then((r) => !cancelled && setResults(r.data))
        .catch(() => !cancelled && setResults([]));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query]);

  const valid =
    patient &&
    lines.length > 0 &&
    lines.every((l) => l.description.trim().length >= 2 && /^\d+(\.\d{1,2})?$/.test(l.amount.trim()));

  /**
   * Display-only running total. The server recomputes it from the lines and
   * that figure is authoritative — a client-side total is a convenience, and if
   * the two ever disagreed the server's would win.
   */
  const previewTotal = lines
    .map((l) => l.amount.trim())
    .filter((a) => /^\d+(\.\d{1,2})?$/.test(a))
    .reduce((minor, a) => {
      const [whole, fraction = ''] = a.split('.');
      return minor + Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
    }, 0);

  async function submit() {
    if (!patient) return;
    setSubmitting(true);
    setError(null);
    try {
      await api('/billing/invoices', {
        method: 'POST',
        body: {
          patientId: patient.id,
          items: lines.map((l) => ({ description: l.description.trim(), amount: l.amount.trim() })),
          dueDate: dueDate ? new Date(`${dueDate}T00:00:00Z`).toISOString() : undefined,
        },
      });
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create that invoice');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      width="w-[480px]"
      title="New invoice"
      footer={
        <>
          <Button variant="primary" disabled={!valid || submitting} onClick={() => void submit()}>
            {submitting ? 'Creating…' : `Create · ${fmt((previewTotal / 100).toFixed(2))}`}
          </Button>
          <Button onClick={onClose}>Cancel</Button>
        </>
      }
    >
      <SectionLabel>Patient</SectionLabel>
      {patient ? (
        <div className="mb-3 flex items-center justify-between rounded-sm border border-border bg-bg px-2.5 py-1.5">
          <span className="text-sm font-medium">
            {patient.fullName}{' '}
            <span className="font-mono text-xs text-text-muted">#{patient.id}</span>
          </span>
          <Button size="sm" onClick={() => setPatient(null)}>
            Change
          </Button>
        </div>
      ) : (
        <Field label="Search" required>
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Name or phone…"
            autoFocus
          />
          {results.length > 0 && (
            <div className="mt-1 max-h-40 overflow-y-auto rounded-sm border border-border">
              {results.map((p) => (
                <button
                  key={p.id}
                  onClick={() => setPatient(p)}
                  className="flex w-full justify-between px-2.5 py-1.5 text-left text-sm hover:bg-primary-soft"
                >
                  <span>{p.fullName}</span>
                  <span className="font-mono text-xs text-text-subtle">#{p.id}</span>
                </button>
              ))}
            </div>
          )}
        </Field>
      )}

      <SectionLabel>Lines</SectionLabel>
      <div className="mb-2 flex flex-wrap gap-1.5">
        {PRESETS.map((preset) => (
          <button
            key={preset.description}
            onClick={() =>
              setLines((prev) => {
                const filtered = prev.filter((l) => l.description.trim() || l.amount.trim());
                return [...filtered, { ...preset }];
              })
            }
            className="rounded-sm border border-border-strong bg-surface px-2 py-1 text-xs hover:border-primary"
          >
            + {preset.description}
          </button>
        ))}
      </div>

      {lines.map((line, i) => (
        <div key={i} className="mb-2 flex items-start gap-2">
          <div className="flex-1">
            <Input
              value={line.description}
              onChange={(e) =>
                setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, description: e.target.value } : l)))
              }
              placeholder="Service description"
            />
          </div>
          <div className="w-24">
            <Input
              value={line.amount}
              onChange={(e) =>
                setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, amount: e.target.value } : l)))
              }
              inputMode="decimal"
              placeholder="0.00"
              className="text-right font-mono"
            />
          </div>
          {lines.length > 1 && (
            <button
              onClick={() => setLines((prev) => prev.filter((_, idx) => idx !== i))}
              className="mt-1.5 text-xs text-danger"
              aria-label="Remove line"
            >
              ×
            </button>
          )}
        </div>
      ))}

      <Button
        size="sm"
        className="w-full"
        onClick={() => setLines((prev) => [...prev, { description: '', amount: '' }])}
      >
        + Add line
      </Button>

      <SectionLabel>Terms</SectionLabel>
      <Field label="Due date" hint="Leave empty for no agreed terms — it will not appear as overdue.">
        <Input type="date" value={dueDate} min={isoDate()} onChange={(e) => setDueDate(e.target.value)} />
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
