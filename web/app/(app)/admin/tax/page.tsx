'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import type { TaxRate } from '@/lib/types';
import {
  Button,
  EmptyState,
  ErrorState,
  Field,
  Input,
  TableSkeleton,
} from '@/components/ui/primitives';

/**
 * The tax rates this hospital charges.
 *
 * WHY NAMED RATES RATHER THAN ONE PERCENTAGE
 * ------------------------------------------
 * A single "tax %" is wrong in both of the places this product is aimed at,
 * and wrong in opposite directions. An Indian pharmacy stocks items at 5%, 12%
 * and 18% at once, and healthcare *services* are exempt while the medicines
 * dispensed at the same visit are not. A US clinic has no national rate — it
 * is state plus county plus city, and prescription drugs are exempt in most
 * states while over-the-counter items are not.
 *
 * So the hospital names the rates it actually uses and points each medicine at
 * one. A hospital that charges no tax defines none, every line resolves to
 * zero, and its invoices look exactly as they did before this page existed.
 * That is the default and most clinics will never come here.
 */
export default function TaxRatesPage() {
  const [rows, setRows] = useState<TaxRate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [percent, setPercent] = useState('');
  /*
   * The parts, if the hospital splits this rate.
   *
   * India needs CGST + SGST shown separately on the invoice; the US needs
   * state + county + city. Both are charged on the same taxable value, so
   * these SUM to the rate above rather than compounding — the server refuses
   * the save if they disagree, rather than quietly fixing one to match the
   * other, because either correction would hide a typo on a legal document.
   */
  const [parts, setParts] = useState<{ name: string; percent: string }[]>([]);
  const [busy, setBusy] = useState(false);
  /*
   * Which rate is being edited, if any.
   *
   * `PATCH /tax-rates/:id` has always accepted a new name, rate and parts —
   * this screen only ever sent `isDefault`, so a typo in a percentage could be
   * created and never corrected. A rate is a number somebody gets wrong once
   * and has to fix; a create-only screen is a create-only mistake.
   */
  const [editing, setEditing] = useState<number | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api<{ data: TaxRate[] }>('/tax-rates');
      setRows(res.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load tax rates');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /*
   * Typed as a percentage, stored as basis points.
   *
   * "12.5" is what a person says and writes; 1250 is what is stored, because a
   * rate is compared and summed and a float is the same trap money-as-a-float
   * is. The conversion lives here so the number in the box always reads the
   * way the hospital's accountant would say it.
   */
  const toBasisPoints = (p: string) => Math.round(Number(p) * 100);
  const validPercent =
    percent.trim() !== '' && Number.isFinite(Number(percent)) && Number(percent) >= 0 && Number(percent) <= 100;

  function beginEdit(r: TaxRate) {
    setEditing(r.id);
    setName(r.name);
    setPercent(String(r.rateBasisPoints / 100));
    setParts(
      r.components.map((c) => ({ name: c.name, percent: String(c.rateBasisPoints / 100) })),
    );
  }

  function cancelEdit() {
    setEditing(null);
    setName('');
    setPercent('');
    setParts([]);
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      /*
       * Two explicit calls rather than one with a ternary over both the path
       * and the verb. `endpoint-coverage.spec.ts` reads client source to find
       * which routes have callers, and a call whose method and URL are both
       * conditional reads as neither — it reported a phantom `GET
       * /tax-rates/:id` and lost the `POST` at the same time.
       *
       * The test was right to complain. A reader has the same problem.
       */
      const body = {
        name: name.trim(),
        rateBasisPoints: toBasisPoints(percent),
        components: parts
          .filter((c) => c.name.trim() && c.percent.trim())
          .map((c) => ({ name: c.name.trim(), rateBasisPoints: toBasisPoints(c.percent) })),
      };

      if (editing) {
        await api(`/tax-rates/${editing}`, { method: 'PATCH', body });
      } else {
        await api('/tax-rates', { method: 'POST', body });
      }
      cancelEdit();
      await load();
    } catch (e) {
      // The server refuses a mismatch between the parts and the total, and
      // says which is which — better wording than a guess here.
      setError(e instanceof ApiError ? e.message : 'Could not save that rate');
    } finally {
      setBusy(false);
    }
  }



  async function remove(id: number, label: string) {
    if (!confirm(`Retire ${label}? Invoices already raised keep the rate they were charged at.`))
      return;
    try {
      await api(`/tax-rates/${id}`, { method: 'DELETE' });
      await load();
    } catch (e) {
      // The server refuses to retire the default, and says why — removing it
      // would silently zero-rate every unassigned medicine.
      setError(e instanceof ApiError ? e.message : 'Could not retire that rate');
    }
  }

  if (error && !rows) return <ErrorState message={error} onRetry={() => void load()} />;

  return (
    <div className="scroll-thin flex-1 overflow-y-auto p-4">
      <div className="mb-4 max-w-2xl">
        <h1 className="text-lg font-semibold text-text">Tax rates</h1>
        <p className="mt-1 text-sm text-text-subtle">
          <strong>Every tax listed here is charged on every sale</strong>, each shown as its own
          line on the invoice. Enter CGST and SGST as two rows and both apply — they add, never
          compound, because both are charged on the same amount.
        </p>
        <p className="mt-1.5 text-xs text-text-subtle">
          A medicine can name one rate instead, for the cases where it differs. To make something
          untaxed, point it at a 0% rate called &ldquo;Exempt&rdquo; — exempt and zero-rated are
          different on a statutory invoice and identical to the arithmetic, which is why rates
          have names.
        </p>
      </div>

      <div className="mb-5 max-w-2xl rounded-md border border-border bg-surface p-4">
        {editing && (
          /*
             Said at the moment of editing, because the reasonable fear is that
             changing a rate silently restates last year's invoices. It does
             not: every line captured its rate, name and split at the moment it
             was billed.
          */
          <p className="mb-3 rounded-sm border border-primary/40 bg-primary-soft px-2.5 py-2 text-xs text-primary">
            Editing an existing rate. Invoices already raised keep the rate and split they were
            charged at — only future sales use the new figures.
          </p>
        )}
        <div className="grid grid-cols-[1fr_140px] gap-3">
          <Field label="Name" required hint="What your staff call it, e.g. GST 12% or Exempt.">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="GST 12%" />
          </Field>
          <Field label="Rate %" required>
            <Input
              value={percent}
              onChange={(e) => setPercent(e.target.value)}
              placeholder="12"
              inputMode="decimal"
              className="text-right font-mono"
            />
          </Field>
        </div>


        {/*
          Optional. Most rates are flat and need none — the section stays
          collapsed to one link until somebody asks for it, so a US clinic with
          a single sales-tax rate never meets a concept it does not use.
        */}
        <div className="mt-3 border-t border-border pt-3">
          <div className="flex items-baseline justify-between">
            <span className="text-xs font-medium text-text">
              Split into parts{' '}
              <span className="font-normal text-text-subtle">
                (CGST + SGST, or state + county)
              </span>
            </span>
            <button
              onClick={() => setParts([...parts, { name: '', percent: '' }])}
              className="text-xs text-primary hover:underline"
            >
              + Add a part
            </button>
          </div>

          {parts.length === 0 ? (
            <p className="mt-1 text-xs text-text-subtle">
              Not split. The invoice shows one tax line.
            </p>
          ) : (
            <>
              {parts.map((c, i) => (
                <div key={i} className="mt-1.5 grid grid-cols-[1fr_100px_auto] items-center gap-2">
                  <Input
                    value={c.name}
                    onChange={(e) =>
                      setParts(parts.map((p, n) => (n === i ? { ...p, name: e.target.value } : p)))
                    }
                    placeholder="CGST"
                  />
                  <Input
                    value={c.percent}
                    onChange={(e) =>
                      setParts(
                        parts.map((p, n) => (n === i ? { ...p, percent: e.target.value } : p)),
                      )
                    }
                    placeholder="6"
                    inputMode="decimal"
                    className="text-right font-mono"
                  />
                  <button
                    onClick={() => setParts(parts.filter((_, n) => n !== i))}
                    className="text-xs text-danger hover:underline"
                  >
                    Remove
                  </button>
                </div>
              ))}

              {/*
                The running sum, checked against the rate as it is typed.
                The server refuses a mismatch; catching it here means the
                refusal is not the first anybody hears of it.
              */}
              {(() => {
                const sum = parts.reduce((t, c) => t + (Number(c.percent) || 0), 0);
                const target = Number(percent) || 0;
                const ok = Math.abs(sum - target) < 0.0001;
                return (
                  <p className={`mt-1.5 text-xs ${ok ? 'text-text-subtle' : 'text-danger'}`}>
                    Parts add up to {sum}% — the rate is {target}%.
                    {ok
                      ? ' They match.'
                      : ' They must sum to the rate: both parts are charged on the same amount, never one on top of the other.'}
                  </p>
                );
              })()}
            </>
          )}
        </div>

        {error && <p className="mt-2 text-sm text-danger">{error}</p>}

        <Button
          variant="primary"
          className="mt-3"
          disabled={busy || name.trim().length < 2 || !validPercent}
          onClick={() => void save()}
        >
          {busy ? 'Saving…' : editing ? 'Save changes' : 'Add rate'}
        </Button>
        {editing && (
          <Button className="ml-2 mt-3" onClick={cancelEdit}>
            Cancel
          </Button>
        )}

        <p className="mt-2 text-xs text-text-subtle">
          0% is a real rate — &ldquo;Exempt&rdquo; and &ldquo;Zero-rated&rdquo; mean different
          things on a statutory invoice and the same thing to the arithmetic, which is why rates
          are named rather than just numeric.
        </p>
      </div>

      {!rows ? (
        <TableSkeleton rows={3} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No tax rates"
          description="Nothing is taxed. Invoices show a single total, as they do now."
        />
      ) : (
        <div className="max-w-2xl overflow-hidden rounded-md border border-border">
          <table className="w-full text-sm">
            <thead className="bg-bg text-left text-xs uppercase text-text-subtle">
              <tr>
                <th className="px-3 py-2">Rate</th>
                <th className="px-3 py-2 text-right">%</th>

                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-border">
                  <td className="px-3 py-2 font-medium">
                    {r.name}
                    {r.components.length > 0 && (
                      <span className="mt-0.5 block text-xxs font-normal text-text-subtle">
                        {r.components.map((c) => `${c.name} ${c.label}`).join(' + ')}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs">{r.label}</td>

                  <td className="px-3 py-2 text-right">
                    {/* Retired, not deleted: invoices record the rate they were
                        charged at, and the row is what a reader follows back
                        to a name. */}
                    <button
                      onClick={() => beginEdit(r)}
                      className="mr-3 text-xs text-primary hover:underline"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => void remove(r.id, r.name)}
                      className="text-xs text-danger hover:underline"
                    >
                      Retire
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/*
            The combined rate, stated.

            With every listed tax applying, the number that matters to an
            administrator is what a sale actually attracts — and reading it off
            a column of rows is exactly the mental arithmetic this screen
            should be doing for them.
          */}
          <div className="flex items-baseline justify-between border-t border-border bg-bg px-3 py-2 text-sm">
            <span className="text-text-muted">Charged on every sale</span>
            <span className="font-mono font-semibold text-text">
              {(rows.reduce((t, r) => t + r.rateBasisPoints, 0) / 100).toString()}%
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
