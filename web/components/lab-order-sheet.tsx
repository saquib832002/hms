'use client';

import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import type { LabOrderDestination, LabPartner, LabPriority, LabTest } from '@/lib/types';
import { lapsedReason } from '@/lib/referral-billing';
import { titleCase } from '@/lib/format';
import { Button, Field, Input, SectionLabel, Select, Textarea } from '@/components/ui/primitives';
import { Sheet } from '@/components/ui/sheet';

/**
 * Request investigations.
 *
 * A side sheet rather than a dialog, like prescribing, and with the patient
 * pinned at the top for the same reason: the commonest catastrophic error in
 * ordering is ordering for the wrong person.
 *
 * WHAT THIS ASKS FOR THAT LOOKS OPTIONAL AND IS NOT
 * ------------------------------------------------
 * The clinical question. A laboratory that does not know why a test was
 * requested cannot comment usefully on the answer — a histopathologist without
 * it is guessing, and a microbiologist cannot tell a contaminant from a
 * pathogen. It is also the one clinical field that crosses to a partner lab,
 * which is said on screen at the moment the destination is chosen rather than
 * buried in a policy.
 */
export function LabOrderSheet({
  open,
  onClose,
  patientId,
  patientName,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  patientId: number;
  patientName: string;
  onSaved: () => void;
}) {
  const { user } = useAuth();
  const [tests, setTests] = useState<LabTest[]>([]);
  const [partners, setPartners] = useState<LabPartner[]>([]);
  const [chosen, setChosen] = useState<number[]>([]);
  const [query, setQuery] = useState('');
  const [priority, setPriority] = useState<LabPriority>('ROUTINE');
  const [destination, setDestination] = useState<LabOrderDestination>('IN_HOUSE');
  const [partnerId, setPartnerId] = useState('');
  const [clinicalDetails, setClinicalDetails] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<{
    id: number;
    accession: string | null;
    referral?: { reference: string; lab: string } | null;
    unpricedTests?: string[];
  } | null>(null);

  useEffect(() => {
    if (!open) {
      setChosen([]);
      setQuery('');
      setPriority('ROUTINE');
      setDestination('IN_HOUSE');
      setPartnerId('');
      setClinicalDetails('');
      setError(null);
      setIssued(null);
      return;
    }

    /*
     * Both fail quietly. An empty catalogue is handled below with a sentence
     * that says what to do about it — the failure this system has hit three
     * times is a screen that shows a spinner for both "nothing configured" and
     * "feature not built", which are indistinguishable and want opposite
     * responses.
     */
    api<{ data: LabTest[] }>('/lab-tests')
      .then((r) => setTests(r.data))
      .catch(() => setTests([]));

    api<{ data: LabPartner[] }>('/lab-partners')
      .then((r) => setPartners(r.data))
      .catch(() => setPartners([]));
  }, [open, patientId]);

  const q = query.trim().toLowerCase();
  const matches = q
    ? tests.filter((t) => t.name.toLowerCase().includes(q) || t.code.toLowerCase().includes(q))
    : tests;

  const selected = tests.filter((t) => chosen.includes(t.id));
  const chosenPartner = partners.find((p) => String(p.id) === partnerId) ?? null;

  /*
   * Will *this* hospital be raising the patient's invoice for this order?
   *
   * Mirrors `hospitalCharges` on the server. Duplicated rather than requested,
   * because it has to answer on every keystroke as the destination changes —
   * and it decides only what the screen says, never what is charged.
   */
  const weCharge =
    destination === 'IN_HOUSE' ||
    (destination === 'PARTNER' && chosenPartner?.billing === 'ORIGIN_PAYS');

  /*
   * Tests we are about to order, will be billing for, and have no price for.
   *
   * THE BUG THIS EXISTS FOR
   * -----------------------
   * Reported after the first real partner referral: the sheet said the patient
   * pays here, and no invoice appeared. The order was correct — `chargeOrder`
   * raises nothing when every line is unpriced, which is right — but the only
   * warning came *after* the order had been sent, by which point the doctor has
   * moved on and the patient is walking out.
   *
   * A clinic that refers its bloods out has every reason to have an unpriced
   * catalogue: it never performs these tests, so nobody ever had cause to set a
   * number. That makes this the normal case for exactly the hospitals this
   * feature is for, not an edge one.
   */
  const unpriced = weCharge ? selected.filter((t) => t.sellingPrice === null) : [];

  /*
   * Pricing is ADMIN and LAB_TECHNICIAN, as it is on the catalogue screen — a
   * doctor mid-consultation should not be setting what the hospital charges.
   * They are told what is wrong and who fixes it, which is the difference
   * between a warning and a dead end.
   */
  const canPrice = user?.role === 'ADMIN' || user?.role === 'LAB_TECHNICIAN';

  /*
   * What that laboratory charges, before the work is sent.
   *
   * Under ORIGIN_PAYS this hospital pays whatever their catalogue says and
   * could not see the number at any point — not when choosing where to send,
   * not when pricing the patient, not afterwards. It arrived as a statement.
   *
   * Fetched per partner rather than for all of them, because a doctor changing
   * their mind between two labs is one extra request and pre-fetching every
   * partner's price list on every order sheet is not.
   */
  const [partnerPrices, setPartnerPrices] = useState<Record<string, string | null> | null>(null);
  /** Inline price entry, keyed by test id. */
  const [priceDraft, setPriceDraft] = useState<Record<number, string>>({});
  const [pricing, setPricing] = useState<number | null>(null);

  useEffect(() => {
    if (destination !== 'PARTNER' || !partnerId) {
      setPartnerPrices(null);
      return;
    }
    let live = true;
    void api<{ data: { code: string; sellingPrice: string | null }[] }>(
      `/lab-partners/${partnerId}/catalogue`,
    )
      .then((res) => {
        if (!live) return;
        setPartnerPrices(
          Object.fromEntries(res.data.map((t) => [t.code.trim().toUpperCase(), t.sellingPrice])),
        );
      })
      /*
       * A price we cannot read is not a reason to block an order. The screen
       * says the price is unknown rather than pretending it is zero — the same
       * distinction `payableExternally` draws one level down.
       */
      .catch(() => live && setPartnerPrices({}));
    return () => {
      live = false;
    };
  }, [destination, partnerId]);

  /*
   * A lapsed partnership is not a valid destination. The server refuses it
   * anyway — it re-checks against the other lab on every order, because their
   * terms change without anybody here being told — and this only stops the
   * doctor reaching the refusal.
   */
  /**
   * Price a test without leaving the sheet.
   *
   * The same `PATCH /lab-tests/:id` the catalogue editor uses — a shortcut to a
   * capability these roles already hold, not a new permission. Refetches the
   * catalogue rather than patching local state, so what the sheet shows is what
   * the server stored.
   */
  async function setPrice(testId: number) {
    setPricing(testId);
    setError(null);
    try {
      await api(`/lab-tests/${testId}`, {
        method: 'PATCH',
        body: { sellingPrice: (priceDraft[testId] ?? '').trim() },
      });
      const res = await api<{ data: LabTest[] }>('/lab-tests');
      setTests(res.data);
      setPriceDraft({ ...priceDraft, [testId]: '' });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not set that price');
    } finally {
      setPricing(null);
    }
  }

  const valid =
    chosen.length > 0 &&
    (destination !== 'PARTNER' || (partnerId !== '' && chosenPartner?.lapsed == null));

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const created = await api<{
        id: number;
        /** The order number — on the label, the worklist and the invoice line. */
        accession: string | null;
        referral?: { reference: string; lab: string } | null;
        unpricedTests?: string[];
      }>('/lab-orders', {
        method: 'POST',
        body: {
          patientId,
          testIds: chosen,
          priority,
          destination,
          partnerId: destination === 'PARTNER' ? Number(partnerId) : undefined,
          clinicalDetails: clinicalDetails.trim() || undefined,
        },
      });
      setIssued(created);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not raise the request');
    } finally {
      setSubmitting(false);
    }
  }

  if (issued) {
    return (
      <Sheet
        open={open}
        onClose={() => {
          setIssued(null);
          onSaved();
        }}
        title="Tests requested"
        footer={
          <Button
            variant="primary"
            onClick={() => {
              setIssued(null);
              onSaved();
            }}
          >
            Done
          </Button>
        }
      >
        {/*
          The order number, and only the order number.
          ------------------------------------------
          This said `#{issued.id}` — the database row id, which appears on no
          label, no invoice line, no worklist row and no report. So the doctor
          was handed the one identifier in the system that maps to nothing, and
          reported it as the order number not being generated at all. It was
          generated; it was never shown.

          The row id is gone rather than demoted. Two numbers against one order
          is worse than the wrong one alone — somebody quotes whichever they
          read first, and only one of them resolves anywhere.
        */}
        <p className="text-sm">
          Request raised for <strong>{patientName}</strong>.
        </p>

        <div className="mt-2 rounded-md border border-border bg-bg px-3 py-2.5">
          <div className="text-xs uppercase text-text-subtle">Order number</div>
          <div className="font-mono text-xl font-semibold tracking-wide text-text">
            {issued.accession ?? '—'}
          </div>
          <div className="mt-1 text-xs text-text-muted">
            On the specimen label, the laboratory&rsquo;s worklist, and the invoice line.
          </div>
        </div>

        {issued.referral && (
          <div className="mt-3 rounded-md border border-primary bg-primary-soft px-3 py-2.5">
            <p className="text-sm text-text">
              Sent to <strong>{issued.referral.lab}</strong>. The patient quotes:
            </p>
            <p className="mt-1 font-mono text-xl font-semibold tracking-widest text-primary">
              {issued.referral.reference}
            </p>
            <p className="mt-1.5 text-xs text-text-muted">
              Their report comes back onto this request. You do not have to chase it separately.
            </p>
          </div>
        )}

        {issued.unpricedTests && issued.unpricedTests.length > 0 && (
          /* Named at the moment it happens rather than found in a report a
             month later. The test is still performed; it is simply not charged
             for, and blank is not zero. */
          <div className="mt-3 rounded-sm border border-[#ecdca6] bg-warning-soft px-3 py-2 text-sm text-[#6b5314]">
            <strong>No invoice was raised for:</strong> {issued.unpricedTests.join(', ')}. Nobody
            here has priced these, so nothing was billed — the tests are still being done. An
            administrator or the laboratory sets a price under <strong>Lab Tests</strong>, and the
            charge can be raised afterwards.
          </div>
        )}
      </Sheet>
    );
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Request tests"
      footer={
        <>
          <Button variant="primary" disabled={!valid || submitting} onClick={() => void submit()}>
            {submitting ? 'Requesting…' : destination === 'PARTNER' ? 'Request and send' : 'Request'}
          </Button>
          <Button onClick={onClose}>Cancel</Button>
        </>
      }
    >
      <div className="rounded border border-border bg-bg p-2.5">
        <div className="text-md font-bold">{patientName}</div>
        <div className="font-mono text-xs text-text-muted">#{patientId}</div>
      </div>

      <SectionLabel>Tests</SectionLabel>

      {tests.length === 0 ? (
        /*
         * An empty catalogue and an unbuilt feature render identically, and
         * this system has been caught by that three times — seed-only
         * medicines, seed-only wards, doctor profiles. So the empty state names
         * the precondition and who can satisfy it.
         */
        <div className="rounded-md border border-border bg-bg px-3 py-3 text-sm text-text-muted">
          <strong className="text-text">No tests in the catalogue yet.</strong> An administrator
          adds them under <strong>Lab Tests</strong> — code, name, what it costs and the reference
          ranges. Until then there is nothing to request.
        </div>
      ) : (
        <>
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name or code…"
            autoComplete="off"
          />

          <div className="scroll-thin mt-2 max-h-72 overflow-y-auto rounded-md border border-border">
            {matches.length === 0 ? (
              <p className="px-3 py-2 text-xs text-text-subtle">Nothing matches.</p>
            ) : (
              matches.map((t) => {
                const picked = chosen.includes(t.id);
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() =>
                      setChosen((prev) =>
                        picked ? prev.filter((id) => id !== t.id) : [...prev, t.id],
                      )
                    }
                    className={`flex w-full items-baseline gap-2 border-b border-[#f0f2f4] px-3 py-1.5 text-left last:border-b-0 hover:bg-primary-soft ${
                      picked ? 'bg-primary-soft' : ''
                    }`}
                  >
                    <span className="w-4 text-primary">{picked ? '✓' : ''}</span>
                    <span className="font-mono text-xs text-text-muted">{t.code}</span>
                    <span className="text-sm">{t.name}</span>
                    <span className="ml-auto text-xxs text-text-subtle">
                      {titleCase(t.specimenType)}
                      {t.turnaroundHours ? ` · ${t.turnaroundHours}h` : ''}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </>
      )}

      {/* Preparation instructions belong with the decision to order, not on a
          form the patient reads later. "Fasting, 8 hours" changes when they
          come back, and the commonest cause of a wasted sample is nobody
          having said it. */}
      {selected.some((t) => t.preparation) && (
        <div className="mt-2 rounded-sm border border-border bg-bg px-3 py-2 text-xs text-text-muted">
          <strong className="text-text">Tell the patient:</strong>
          <ul className="mt-1 list-inside list-disc">
            {selected
              .filter((t) => t.preparation)
              .map((t) => (
                <li key={t.id}>
                  {t.name} — {t.preparation}
                </li>
              ))}
          </ul>
        </div>
      )}

      <div className="mt-3 grid grid-cols-2 gap-2.5">
        <Field label="Priority">
          <Select value={priority} onChange={(e) => setPriority(e.target.value as LabPriority)}>
            <option value="ROUTINE">Routine</option>
            <option value="URGENT">Urgent</option>
            <option value="STAT">Immediately (STAT)</option>
          </Select>
        </Field>
      </div>

      {/* Priority orders the worklist and does nothing else. Said plainly,
          because a control that looks like it summons somebody and does not is
          worse than no control — the technician stops trusting the label. */}
      {priority !== 'ROUTINE' && (
        <p className="-mt-1 text-xs text-text-subtle">
          This moves the request to the top of the laboratory&rsquo;s worklist. It does not notify
          anybody — if it cannot wait, telephone them as well.
        </p>
      )}

      <SectionLabel>Clinical details</SectionLabel>
      <Textarea
        rows={2}
        value={clinicalDetails}
        onChange={(e) => setClinicalDetails(e.target.value)}
        placeholder="?anaemia, 3 months — or what you are asking the lab"
      />
      <p className="mt-1 text-xs text-text-subtle">
        The laboratory reads this. Without it they cannot comment usefully on the result.
      </p>

      <SectionLabel>Where it will be done</SectionLabel>
      <Select
        value={destination}
        onChange={(e) => setDestination(e.target.value as LabOrderDestination)}
      >
        <option value="IN_HOUSE">Our lab</option>
        <option value="EXTERNAL">Patient takes the form elsewhere</option>
        {partners.length > 0 ? (
          <option value="PARTNER">Send to a partner lab</option>
        ) : (
          /*
           * Shown disabled rather than omitted. A missing option is
           * indistinguishable from a feature that does not exist — the exact
           * report that came back from the pharmacy side, where an
           * administrator switched on the receiving half and then saw two
           * choices with nothing to say the setup was unfinished.
           */
          <option value="PARTNER" disabled>
            Send to a partner lab — none added yet
          </option>
        )}
      </Select>

      {partners.length === 0 && (
        <p className="mt-1.5 text-xs text-text-subtle">
          Sending to another hospital&rsquo;s lab needs them to accept external orders <em>and</em>{' '}
          an administrator here to add them under <strong>Partner labs</strong>, using the code that
          lab gives you.
        </p>
      )}

      {destination === 'PARTNER' && (
        <>
          <Select
            value={partnerId}
            onChange={(e) => setPartnerId(e.target.value)}
            className="mt-1.5"
          >
            <option value="">Choose a laboratory…</option>
            {partners.map((p) => (
              /*
               * A partnership the other lab has since changed under us cannot
               * be ordered through, and saying so here is the whole point: the
               * doctor cannot fix it, so meeting it as a refusal *after*
               * choosing the tests is a dead end in front of a patient. Named
               * in the list instead, before it is picked.
               */
              <option key={p.id} value={p.id} disabled={p.lapsed !== null}>
                {p.label}
                {p.lapsed
                  ? ' — unavailable, ask an administrator'
                  : p.billing === 'PATIENT_PAYS'
                    ? ' — patient pays them directly'
                    : ''}
              </option>
            ))}
          </Select>

          {/*
            Who is charging, before the order is sent.
            -----------------------------------------
            It changes what the doctor tells the patient on the way out —
            "settle it at reception" or "take this to the lab and pay there" —
            and there is no second chance to say it once they have left.
          */}
          {chosenPartner && !chosenPartner.lapsed && (
            <p
              className={`mt-1.5 rounded-sm px-2 py-1.5 text-xs ${
                chosenPartner.billing === 'PATIENT_PAYS'
                  ? 'bg-accent-soft text-text'
                  : 'bg-bg text-text-muted'
              }`}
            >
              {chosenPartner.billing === 'PATIENT_PAYS'
                ? `We will not charge for this. The patient pays ${chosenPartner.label} at their counter.`
                : `We charge the patient for this here. ${chosenPartner.label} invoices us.`}
            </p>
          )}

          {chosenPartner?.lapsed && (
            <p className="mt-1.5 rounded-sm bg-warning-soft px-2 py-1.5 text-xs text-text">
              {lapsedReason(chosenPartner.lapsed, chosenPartner.label)}
            </p>
          )}

          {/*
            Their price against ours, per test, with the difference.
            ------------------------------------------------------
            Only under ORIGIN_PAYS: that is the arrangement where this hospital
            actually pays, and under PATIENT_PAYS we charge nothing and their
            price is between them and the patient.

            Shown as three numbers rather than one, because the useful fact is
            not "they charge 500" — it is whether what we are charging the
            patient covers it. A clinic finds out it is selling at a loss when
            the statement arrives, which is exactly the gap this closes.
          */}
          {chosenPartner &&
            !chosenPartner.lapsed &&
            chosenPartner.billing === 'ORIGIN_PAYS' &&
            selected.length > 0 && (
              <div className="mt-2 rounded-sm border border-border bg-bg px-2 py-1.5 text-xs">
                <div className="mb-1 font-semibold text-text">
                  What {chosenPartner.label} will charge us
                </div>
                {partnerPrices === null ? (
                  <div className="text-text-subtle">Checking their price list…</div>
                ) : (
                  <>
                    {selected.map((t) => {
                      const theirs = partnerPrices[t.code.trim().toUpperCase()] ?? null;
                      const ours = t.sellingPrice;
                      return (
                        <div key={t.id} className="flex gap-2 py-0.5 text-text-muted">
                          <span className="flex-1 truncate">{t.name}</span>
                          <span>
                            {/*
                              Three separate absences, and they mean different
                              things. They have not priced it; we have not
                              priced it; we could not read their list at all.
                              Rendering any of them as a blank or a zero is the
                              mistake this codebase has made three times.
                            */}
                            {theirs === null ? 'their price unknown' : `they charge ${theirs}`}
                            {' · '}
                            {ours === null ? 'we have no price set' : `we charge ${ours}`}
                          </span>
                        </div>
                      );
                    })}
                    {selected.some(
                      (t) =>
                        t.sellingPrice !== null &&
                        (partnerPrices[t.code.trim().toUpperCase()] ?? null) !== null &&
                        Number(partnerPrices[t.code.trim().toUpperCase()]) >
                          Number(t.sellingPrice),
                    ) && (
                      <div className="mt-1 font-semibold text-warning">
                        We are charging the patient less than the laboratory charges us for at
                        least one of these.
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

          {/* Said at the point where patient data leaves the hospital. */}
          <p className="mt-1.5 text-xs text-text-subtle">
            The tests, your clinical details and the patient&rsquo;s name and date of birth are sent
            to that laboratory. Nothing else — no diagnosis, notes, allergies or other results.
            Their report comes back onto this request.
          </p>
        </>
      )}

      {/*
        Tests we are about to bill for and cannot.
        -----------------------------------------
        Before the order is sent, where it can still be fixed. The same
        information used to arrive only afterwards, as "not charged for" on a
        confirmation the doctor has already stopped reading — which is how a
        referral came back billed by the laboratory and not billed to the
        patient, with nothing on screen at the time saying why.

        A missing price is fixed where it is found. That is what the dispensing
        sheet does, and for the same reason: the alternative is abandoning the
        task, going to another screen, and starting again with somebody waiting.
      */}
      {unpriced.length > 0 && (
        <div className="mt-2 rounded-sm border border-[#ecdca6] bg-warning-soft px-3 py-2 text-sm text-[#6b5314]">
          <strong>No invoice will be raised for:</strong>{' '}
          {unpriced.map((t) => t.name).join(', ')}.
          <div className="mt-0.5 text-xs">
            {/*
              Blank is not zero, said again here because this is the moment it
              matters. The test is still ordered and still performed; it is
              simply not charged for.
            */}
            Nobody here has priced {unpriced.length === 1 ? 'it' : 'them'}. The
            {unpriced.length === 1 ? ' test' : ' tests'} will still be done.
          </div>

          {canPrice ? (
            <div className="mt-2 space-y-1.5">
              {unpriced.map((t) => {
                const theirs = partnerPrices?.[t.code.trim().toUpperCase()] ?? null;
                return (
                  <div key={t.id} className="flex items-center gap-2">
                    <span className="flex-1 truncate text-xs">{t.name}</span>
                    <Input
                      value={priceDraft[t.id] ?? ''}
                      onChange={(e) => setPriceDraft({ ...priceDraft, [t.id]: e.target.value })}
                      /*
                       * Their price as the placeholder, never as the value. A
                       * clinic pricing a send-out starts from what the lab
                       * charges, but silently prefilling it would set every
                       * referral to zero margin without anybody deciding to —
                       * and `unitPrice` is captured, so it would be invisible
                       * afterwards.
                       */
                      placeholder={theirs ? `they charge ${theirs}` : '0.00'}
                      className="w-28 text-xs"
                    />
                    <Button
                      size="sm"
                      disabled={pricing === t.id || !(priceDraft[t.id] ?? '').trim()}
                      onClick={() => void setPrice(t.id)}
                    >
                      Set price
                    </Button>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="mt-1 text-xs">
              An administrator or the laboratory can set a price under <strong>Lab Tests</strong>.
            </div>
          )}
        </div>
      )}

      {destination === 'EXTERNAL' && (
        <p className="mt-1.5 text-xs text-text-subtle">
          Print it for the patient. It will not appear on our worklist, and the result has to be
          typed in when it arrives — but our lab can still run it if they come back.
        </p>
      )}

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
