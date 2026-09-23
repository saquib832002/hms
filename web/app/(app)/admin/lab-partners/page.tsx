'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import type { LabPartner, ReferralBilling } from '@/lib/types';
import {
  BILLING_HINT,
  BILLING_LABEL,
  BILLING_MODES,
  lapsedReason,
  unavailableReason,
} from '@/lib/referral-billing';
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
 * Labs at other hospitals that this one may send tests to.
 *
 * WHY THERE IS NO LIST TO PICK FROM
 * ---------------------------------
 * The same trap as partner pharmacies: a dropdown of every hospital on the
 * platform running a lab is the provider's customer base, browsable by every
 * administrator. So partnerships start offline — the lab gives out a short
 * code, this is where it is typed, and the lookup gives one identical answer
 * for "no such code", "they run no lab" and "they have not opted in".
 *
 * WHAT MAKES A LAB PARTNERSHIP DIFFERENT FROM A PHARMACY ONE
 * ----------------------------------------------------------
 * Results come back. A prescription referral is one-way — the medicine is
 * handed to the patient and this hospital never hears again — and that is a
 * known gap there. It could not be one here: an order that goes out and never
 * returns is a doctor telephoning another company for a number, which is what
 * this replaces. The partner writes the report into this hospital's own
 * records, and it appears on the patient's file like any other.
 *
 * That is worth saying on the screen, because it is the thing an administrator
 * needs to know before agreeing to it.
 */
export default function LabPartnersPage() {
  const [rows, setRows] = useState<LabPartner[] | null>(null);
  const [slug, setSlug] = useState('');
  const [label, setLabel] = useState('');
  /*
   * Defaults to the arrangement every partnership predating this had, so an
   * administrator who does not think about it gets what they already have
   * rather than a surprise on the first invoice.
   */
  const [billing, setBilling] = useState<ReferralBilling>('ORIGIN_PAYS');
  const [savingBilling, setSavingBilling] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api<{ data: LabPartner[] }>('/lab-partners');
      setRows(res.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load partner labs');
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
      await api('/lab-partners', {
        method: 'POST',
        body: { slug: slug.trim().toLowerCase(), label: label.trim(), billing },
      });
      setSlug('');
      setLabel('');
      setBilling('ORIGIN_PAYS');
      setNotice('Added. Doctors can now send tests there, and results come back here.');
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not add that lab');
    } finally {
      setBusy(false);
    }
  }

  /**
   * Change how an existing partnership is billed.
   *
   * Its own action rather than remove-and-re-add, which is what an
   * administrator would otherwise have to do: that soft-deletes a row every
   * order already sent points at, and "where did this go" is asked precisely
   * when a partnership has changed.
   *
   * The server re-checks against the other lab, so a mode they have since
   * withdrawn is refused here with their reason rather than saved and
   * discovered by a doctor mid-consultation.
   */
  async function setBillingFor(id: number, mode: ReferralBilling) {
    setSavingBilling(id);
    setError(null);
    setNotice(null);
    try {
      await api(`/lab-partners/${id}`, { method: 'PATCH', body: { billing: mode } });
      setNotice('Saved. This applies to tests sent from now on, not to ones already sent.');
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not change how that partner is billed');
    } finally {
      setSavingBilling(null);
    }
  }

  async function remove(id: number, name: string) {
    /*
     * Deactivated rather than deleted, and the wording says it can be added
     * back. The silent version of this sent somebody into a dead end at the
     * pharmacy: removed, then refused on re-add as "already a partner", about a
     * row the list does not show, with a database console as the only exit.
     */
    if (!confirm(`Stop sending tests to ${name}? You can add them back with the same code.`)) return;
    try {
      await api(`/lab-partners/${id}`, { method: 'DELETE' });
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not remove that partner');
    }
  }

  if (error && !rows) return <ErrorState message={error} onRetry={() => void load()} />;

  return (
    <div className="scroll-thin flex-1 overflow-y-auto p-4">
      <div className="mb-4">
        <h1 className="text-lg font-semibold text-text">Partner labs</h1>
        <p className="text-sm text-text-muted">
          Where your doctors may send a test instead of your own lab.
        </p>
      </div>

      <div className="mb-5 max-w-lg rounded-md border border-border bg-surface p-4">
        <p className="mb-3 text-sm text-text-muted">
          Ask the lab for their code. They have to switch on{' '}
          <strong>accept orders from other hospitals</strong> in their own settings before you can
          add them.
        </p>

        {/* Said before the partnership is created rather than discovered
            afterwards. This is the only place in the system where another
            company writes into this hospital's patient records, and an
            administrator should agree to it knowingly. */}
        <div className="mb-3 rounded-sm border border-border bg-bg px-3 py-2 text-xs text-text-muted">
          <strong className="text-text">What is shared, both ways.</strong> Going out: the
          patient&rsquo;s name and date of birth, the tests, and the clinical question your doctor
          typed. No diagnosis, notes, allergies or other results. Coming back: their report, filed
          against your order and readable by your clinicians like any other.
        </div>

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
              placeholder="St Mary's Pathology"
            />
          </Field>
        </div>

        <div className="mt-3" />
        <Field
          label="Who pays them"
          hint="You can change this later. It applies to tests sent from then on, never to ones already sent."
        >
          <div className="space-y-2">
            {BILLING_MODES.map((m) => (
              <label key={m} className="flex cursor-pointer items-start gap-2">
                <input
                  type="radio"
                  name="new-partner-billing"
                  className="mt-1"
                  checked={billing === m}
                  onChange={() => setBilling(m)}
                />
                <span>
                  <span className="text-sm font-medium text-text">{BILLING_LABEL[m]}</span>
                  <span className="block text-xs text-text-muted">{BILLING_HINT[m]}</span>
                </span>
              </label>
            ))}
          </div>
        </Field>

        {/* Said here because it is the half an administrator on this side
            cannot see. The other lab decides what it will take, and a refusal
            on save that did not explain whose switch is missing would read as
            this screen being broken. */}
        <p className="mt-2 text-xs text-text-subtle">
          The lab has to accept work on those terms at their end. If they do not, adding them is
          refused and the message says which way they do take it.
        </p>

        {error && <p className="mt-2 text-sm text-danger">{error}</p>}
        {notice && <p className="mt-2 text-sm text-success">{notice}</p>}

        <Button
          variant="primary"
          className="mt-3"
          disabled={busy || slug.trim().length < 2 || label.trim().length < 2}
          onClick={() => void add()}
        >
          {busy ? 'Adding…' : 'Add partner lab'}
        </Button>
      </div>

      {!rows ? (
        <TableSkeleton rows={3} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No partner labs"
          description="Until you add one, your doctors can send a test to your own lab or give the patient a form to take elsewhere."
        />
      ) : (
        <div className="overflow-hidden rounded-md border border-border">
          <table className="w-full text-sm">
            <thead className="bg-bg text-left text-xs uppercase text-text-subtle">
              <tr>
                <th className="px-3 py-2">Laboratory</th>
                <th className="px-3 py-2">Who pays</th>
                <th className="px-3 py-2">Added</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id} className="border-t border-border align-top">
                  <td className="px-3 py-2 font-medium">
                    {p.label}
                    {/* A partnership the other end has changed under us. Named
                        here, where somebody can act on it, rather than left to
                        surface as a refusal in front of a patient. */}
                    {p.lapsed && (
                      <span className="mt-1 block text-xs font-normal text-warning">
                        {lapsedReason(p.lapsed, p.label)}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <select
                      value={p.billing}
                      disabled={savingBilling === p.id}
                      onChange={(e) => void setBillingFor(p.id, e.target.value as ReferralBilling)}
                      className="rounded-sm border border-border bg-surface px-2 py-1 text-xs"
                    >
                      {BILLING_MODES.map((m) => {
                        /*
                         * Shown disabled with the reason rather than omitted.
                         * A missing option is indistinguishable from a feature
                         * that does not exist, and the administrator here
                         * cannot otherwise discover that the missing half is a
                         * switch at the other hospital — which is exactly how
                         * the partner-pharmacy handshake read as broken.
                         */
                        const why = unavailableReason(m, p.accepts, p.label);
                        return (
                          <option key={m} value={m} disabled={why !== null && p.billing !== m}>
                            {BILLING_LABEL[m]}
                            {why ? ' — they do not offer this' : ''}
                          </option>
                        );
                      })}
                    </select>
                  </td>
                  <td className="px-3 py-2 text-xs text-text-muted">{date(p.createdAt)}</td>
                  <td className="px-3 py-2 text-right">
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
