'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { Button, ErrorState, Field, TableSkeleton } from '@/components/ui/primitives';
import { TimezoneSelect } from '@/components/ui/timezone-select';
import { MODULE_LABEL } from '@/lib/nav';
import type { ReferralBilling, TaxRate, TenantModule } from '@/lib/types';
import { BILLING_LABEL_INBOUND, BILLING_MODES } from '@/lib/referral-billing';
import Link from 'next/link';

interface ClinicSettings {
  timezone: string;
  slotMinutes: number;
  clinicStartHour: number;
  clinicEndHour: number;
  currency: string;
  pharmacyBilling: 'SEPARATE' | 'COMBINED';
  hasPharmacy: boolean;
  acceptsExternalPrescriptions: boolean;
  labBilling: 'SEPARATE' | 'COMBINED';
  hasLab: boolean;
  acceptsExternalLabOrders: boolean;
  acceptedReferralBilling: ReferralBilling[];
  taxEnabled: boolean;
  pricesIncludeTax: boolean;
  consultationTaxRateId: number | null;
  slotsPerDoctorPerDay: number;
  summary: string;
  allowedSlotMinutes: number[];
}

/**
 * A short list rather than every ISO 4217 code.
 *
 * ~180 currencies exist and a hospital uses exactly one, so an exhaustive
 * dropdown is all cost and no benefit. The server accepts any valid code, so
 * adding one here is a one-line change and nothing else has to move.
 */
const CURRENCIES = [
  { code: 'GBP', name: 'Pound sterling' },
  { code: 'USD', name: 'US dollar' },
  { code: 'EUR', name: 'Euro' },
  { code: 'INR', name: 'Indian rupee' },
  { code: 'CAD', name: 'Canadian dollar' },
  { code: 'AUD', name: 'Australian dollar' },
  { code: 'AED', name: 'UAE dirham' },
  { code: 'SAR', name: 'Saudi riyal' },
  { code: 'PKR', name: 'Pakistani rupee' },
  { code: 'BDT', name: 'Bangladeshi taka' },
  { code: 'LKR', name: 'Sri Lankan rupee' },
  { code: 'NPR', name: 'Nepalese rupee' },
  { code: 'SGD', name: 'Singapore dollar' },
  { code: 'MYR', name: 'Malaysian ringgit' },
  { code: 'ZAR', name: 'South African rand' },
  { code: 'NGN', name: 'Nigerian naira' },
  { code: 'KES', name: 'Kenyan shilling' },
  { code: 'JPY', name: 'Japanese yen' },
  { code: 'CNY', name: 'Chinese yuan' },
  { code: 'BRL', name: 'Brazilian real' },
];

function symbolFor(code: string): string {
  try {
    return (
      new Intl.NumberFormat(undefined, { style: 'currency', currency: code })
        .formatToParts(0)
        .find((p) => p.type === 'currency')?.value ?? code
    );
  } catch {
    return code;
  }
}

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const hh = (h: number) => `${String(h).padStart(2, '0')}:00`;

/**
 * The hospital's clinic day.
 *
 * These are not display preferences — they generate the booking grid. Changing
 * the slot length changes which appointment times exist; changing the timezone
 * moves the whole clinic day. The screen says so, because a setting that
 * quietly reshapes the appointment book is worse than one that explains itself.
 */
export default function ClinicSettingsPage() {
  const { user, refreshUser } = useAuth();
  /*
   * What this hospital was sold. A setting for a module they do not have is a
   * control that does nothing — the write is refused server-side — and reading
   * about it is a price list for something they did not buy.
   */
  const has = (module: TenantModule) => user?.hospital.modules.includes(module) ?? true;
  const [saved, setSaved] = useState<ClinicSettings | null>(null);
  const [form, setForm] = useState<Partial<ClinicSettings>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /*
   * The rate list, for the consultation picker.
   *
   * Fetched here rather than duplicated: the Tax Rates screen owns creating
   * them, this screen only chooses one. Fails quietly to an empty list, which
   * renders as "No tax on consultations" — the correct answer for a hospital
   * that has not set any up.
   */
  const [rates, setRates] = useState<TaxRate[]>([]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api<ClinicSettings>('/admin/clinic-settings');
      setSaved(res);
      setForm(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load settings');
    }
  }, []);

  useEffect(() => {
    void load();
    // `/tax-rates` belongs to BILLING and this screen does not. Clinic settings
    // is part of the floor every tenant gets, so it cannot carry a module tag
    // of its own — the part that varies is one block, not the page.
    if (!has('BILLING')) return;
    api<{ data: TaxRate[] }>('/tax-rates')
      .then((r) => setRates(r.data))
      .catch(() => setRates([]));
  }, [load]);

  const changed =
    saved !== null &&
    (
      [
        'timezone',
        'slotMinutes',
        'clinicStartHour',
        'clinicEndHour',
        'currency',
        'pharmacyBilling',
        'hasPharmacy',
        'acceptsExternalPrescriptions',
        'labBilling',
        'hasLab',
        'acceptsExternalLabOrders',
        'taxEnabled',
        'pricesIncludeTax',
        'consultationTaxRateId',
      ] as const
    ).some(
      (k) => form[k] !== saved[k],
    ) ||
    /*
     * Compared by content, not identity. Every `setForm` builds a new array, so
     * `!==` is true on every keystroke and Save never goes quiet — which trains
     * people to ignore whether it is lit.
     */
    (form.acceptedReferralBilling ?? []).join(',') !==
      (saved?.acceptedReferralBilling ?? []).join(',');

  async function save() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api<ClinicSettings>('/admin/clinic-settings', {
        method: 'PATCH',
        body: {
          timezone: form.timezone,
          slotMinutes: Number(form.slotMinutes),
          clinicStartHour: Number(form.clinicStartHour),
          clinicEndHour: Number(form.clinicEndHour),
          currency: form.currency,
          pharmacyBilling: form.pharmacyBilling,
          hasPharmacy: form.hasPharmacy,
          acceptsExternalPrescriptions: form.acceptsExternalPrescriptions,
          labBilling: form.labBilling,
          hasLab: form.hasLab,
          acceptsExternalLabOrders: form.acceptsExternalLabOrders,
          acceptedReferralBilling: form.acceptedReferralBilling,
          taxEnabled: form.taxEnabled,
          pricesIncludeTax: form.pricesIncludeTax,
          consultationTaxRateId: form.consultationTaxRateId,
        },
      });
      setSaved(res);
      setForm(res);
      // The currency symbol shown on every other screen comes from the cached
      // session, not from this response. Without this it stays stale until the
      // next sign-in, which reads as the save not having worked.
      await refreshUser();
      setNotice('Saved. New appointment slots use these settings from now on.');
    } catch (e) {
      // The server explains why — an end hour before the start, an unknown
      // timezone, a slot length that does not divide an hour.
      setError(e instanceof ApiError ? e.message : 'Could not save settings');
    } finally {
      setBusy(false);
    }
  }

  if (error && !saved) return <ErrorState message={error} onRetry={() => void load()} />;
  if (!saved) return <TableSkeleton rows={4} />;

  return (
    /*
      The shell's <main> is overflow-hidden, so every page owns its own
      scrolling. This one did not, and grew past the fold when the pharmacy
      settings were added — the fields below simply could not be reached.

      The scroller is full width and the column inside it stays narrow: putting
      max-w on the scrolling element itself would leave the scrollbar floating
      in the middle of the screen.
    */
    <div className="scroll-thin flex-1 overflow-y-auto p-4">
      <div className="max-w-2xl space-y-6">
      <header>
        <h1 className="text-lg font-semibold text-text">Clinic settings</h1>
        <p className="mt-1 text-sm text-text-subtle">
          These decide which appointment times exist. They apply to this hospital only.
        </p>
      </header>

      <div className="rounded-lg border border-border bg-surface p-4 text-sm">
        <div className="font-medium text-text">Currently: {saved.summary}</div>
        <div className="mt-1 text-text-subtle">
          {saved.slotsPerDoctorPerDay} appointment slots per doctor per day
        </div>

        {/*
          This hospital's code, shown unconditionally.

          It was first put beside the "accept prescriptions from other
          hospitals" toggle, which is where it is used — and that was wrong in
          two ways. A hospital cannot decide whether to switch that on without
          knowing what it would be handing out, and the code identifies them in
          any support conversation, which has nothing to do with pharmacies.

          More importantly it is the *only* place this string appears. The
          vendor picks the slug at approval and nothing conveys it to the
          customer; the login form has no hospital field. Hiding it behind a
          setting meant a hospital that had not found that setting had no way
          to learn its own name.
        */}
        <div className="mt-2.5 border-t border-border pt-2.5 text-text-subtle">
          Your hospital&rsquo;s code is{' '}
          <code className="rounded-sm bg-bg px-1.5 py-0.5 font-mono text-sm text-text">
            {user?.hospital.slug}
          </code>
          <span className="mt-1 block text-xs">
            Quote it to support, and give it to any hospital that wants to send prescriptions to
            your pharmacy.
          </span>
        </div>

        {/*
          What this hospital has been sold, shown to its own administrator.

          Read-only here on purpose — only the vendor may change it, and a
          hospital administrator who could would be selling themselves the lab.
          But not showing it at all was a real gap: the menu simply omits the
          screens, so a module removed this morning and a module never bought
          look identical from inside, and the 403 that names the module only
          arrives if somebody finds a way to attempt a write.

          It is also the only place an administrator can confirm a change the
          vendor has just made actually reached them, which is the first thing
          either party wants during that telephone call.
        */}
        <div className="mt-2.5 border-t border-border pt-2.5 text-text-subtle">
          Your plan includes{' '}
          {(user?.hospital.modules?.length ?? 0) === 0 ? (
            <span className="text-text">
              patients, staff accounts, settings and your audit log only
            </span>
          ) : (
            <span className="text-text">
              {user?.hospital.modules.map((m) => MODULE_LABEL[m]).join(', ')}
            </span>
          )}
          .
          <span className="mt-1 block text-xs">
            Patients, staff accounts, settings and the audit log are always included. Anything not
            listed is unavailable rather than empty — ask your provider to enable it, and whatever
            was recorded under it comes back with it.
          </span>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Timezone"
          required
          hint="The hospital's wall clock — it decides what 'today' means on a queue."
        >
          <TimezoneSelect
            value={form.timezone ?? 'UTC'}
            onChange={(timezone) => setForm({ ...form, timezone })}
          />
        </Field>

        <Field label="Slot length" required hint="How long one appointment lasts.">
          <select
            className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm"
            value={form.slotMinutes ?? 30}
            onChange={(e) => setForm({ ...form, slotMinutes: Number(e.target.value) })}
          >
            {saved.allowedSlotMinutes.map((m) => (
              <option key={m} value={m}>
                {m} minutes
              </option>
            ))}
          </select>
        </Field>

        <Field
          label="Currency"
          required
          hint="Changes the symbol on invoices and reports. Amounts are NOT converted."
        >
          <select
            className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm"
            value={form.currency ?? 'GBP'}
            onChange={(e) => setForm({ ...form, currency: e.target.value })}
          >
            {CURRENCIES.map((c) => (
              <option key={c.code} value={c.code}>
                {c.code} — {c.name} ({symbolFor(c.code)})
              </option>
            ))}
          </select>
        </Field>

        <Field label="Opens" required>
          <select
            className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm"
            value={form.clinicStartHour ?? 9}
            onChange={(e) => setForm({ ...form, clinicStartHour: Number(e.target.value) })}
          >
            {HOURS.map((h) => (
              <option key={h} value={h}>
                {hh(h)}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Closes" required hint="The last slot begins before this hour.">
          <select
            className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm"
            value={form.clinicEndHour ?? 17}
            onChange={(e) => setForm({ ...form, clinicEndHour: Number(e.target.value) })}
          >
            {HOURS.map((h) => (
              <option key={h} value={h}>
                {hh(h)}
              </option>
            ))}
          </select>
        </Field>
      </div>

      {/*
        Only for a hospital that has the module.
        --------------------------------------
        Not a security boundary — `ModuleGuard` refuses the writes — but a
        pharmacy-only tenant reading about lab billing modes is being shown the
        price list for something they did not buy, and a lab-only one has no
        opinion about dispensing at all.
      */}
      {has('PHARMACY') && (
      <>
      {/*
        The pharmacy is either a department or a business, and this is the one
        setting that decides it. Worded as a consequence rather than a label,
        because "separate" and "combined" on their own do not tell an owner what
        will be different tomorrow morning.
      */}
      <Field
        label="Pharmacy billing"
        required
        hint="Whether medicines are charged on their own bill or added to the patient's hospital bill."
      >
        <select
          className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm"
          value={form.pharmacyBilling ?? 'SEPARATE'}
          onChange={(e) =>
            setForm({ ...form, pharmacyBilling: e.target.value as 'SEPARATE' | 'COMBINED' })
          }
        >
          <option value="SEPARATE">Separate — the pharmacy bills and is paid on its own</option>
          <option value="COMBINED">Combined — medicines go on the hospital bill</option>
        </select>
      </Field>

      <p className="rounded-md border border-border bg-bg px-3 py-2 text-xs text-text-muted">
        {form.pharmacyBilling === 'COMBINED' ? (
          <>
            Medicines are added to the patient&rsquo;s open hospital invoice, so there is one
            balance to settle at the desk. Billing staff see a single{' '}
            <strong>Medicines</strong> line with a total — never the drug names, which stay
            visible to the pharmacist and to you.
          </>
        ) : (
          <>
            Medicines are charged on their own pharmacy invoice and paid at the pharmacy counter.
            Billing staff do not see pharmacy invoices at all, and pharmacy takings are reported
            separately from the hospital&rsquo;s.
          </>
        )}
      </p>

      {/*
        Whether there is a pharmacy at all, and whether it takes outside work.
        Both are about the same room, so they sit together — and the second is
        meaningless without the first, which is why it disappears when the
        first is off.
      */}
      <label className="flex cursor-pointer items-start gap-2.5 rounded-md border border-border bg-surface px-3 py-2.5 text-sm">
        <input
          type="checkbox"
          checked={form.hasPharmacy ?? true}
          onChange={(e) => setForm({ ...form, hasPharmacy: e.target.checked })}
          className="mt-0.5 h-4 w-4"
        />
        <span>
          <span className="font-medium">This hospital has its own pharmacy</span>
          <span className="mt-0.5 block text-xs text-text-muted">
            Turn off for a clinic that does not dispense. Doctors stop being asked where a
            prescription goes — every one is handed to the patient — and the dispensing screens
            have nothing to show.
          </span>
        </span>
      </label>

      {form.hasPharmacy !== false && (
        <div className="rounded-md border border-border bg-surface">
          <label className="flex cursor-pointer items-start gap-2.5 px-3 py-2.5 text-sm">
            <input
              type="checkbox"
              checked={form.acceptsExternalPrescriptions ?? false}
              onChange={(e) =>
                setForm({ ...form, acceptsExternalPrescriptions: e.target.checked })
              }
              className="mt-0.5 h-4 w-4"
            />
            <span>
              <span className="font-medium">Accept prescriptions from other hospitals</span>
              <span className="mt-0.5 block text-xs text-text-muted">
                Makes you <em>findable</em> by a hospital that already has your code. They still
                have to add you deliberately — nobody can browse a list of pharmacies. Off means
                you are not findable at all.
              </span>
            </span>
          </label>

          {/*
            The other half of a two-sided agreement. Switching this on does
            nothing observable until some other hospital types your code into
            their partners screen, so the waiting step is named here rather
            than left to be discovered by its absence. The code itself lives at
            the top of this page, where it is readable whether or not this is
            switched on.
          */}
          {form.acceptsExternalPrescriptions && (
            <p className="border-t border-border px-3 py-2.5 text-xs text-text-muted">
              Give them the code at the top of this page. They add it under{' '}
              <strong>Partner pharmacies</strong> at their end — nothing arrives until they do.
            </p>
          )}
        </div>
      )}

      </>
      )}

      {has('LABORATORY') && (
      <>
      {/*
        The laboratory, on exactly the same three questions as the pharmacy.
        ------------------------------------------------------------------
        Deliberately not folded in with the pharmacy's switches. A hospital may
        run one, both or neither, and a single "accept work from other
        hospitals" would mean a clinic that wants to take in bloods has also
        agreed to dispense other people's prescriptions — two different rooms,
        two different agreements.

        This section had to be built twice, in effect: the columns and the
        partner lookup shipped without it, so every attempt to add a partner lab
        was refused with "no lab is accepting orders under that code". A correct
        refusal, naming a precondition nothing in the product could satisfy.
      */}
      <Field
        label="Lab billing"
        required
        hint="Whether tests are charged on their own bill or added to the patient's hospital bill."
      >
        <select
          className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm"
          value={form.labBilling ?? 'SEPARATE'}
          onChange={(e) =>
            setForm({ ...form, labBilling: e.target.value as 'SEPARATE' | 'COMBINED' })
          }
        >
          <option value="SEPARATE">Separate — the lab bills and is paid on its own</option>
          <option value="COMBINED">Combined — tests go on the hospital bill</option>
        </select>
      </Field>

      <p className="rounded-md border border-border bg-bg px-3 py-2 text-xs text-text-muted">
        {form.labBilling === 'COMBINED' ? (
          <>
            Tests are added to the patient&rsquo;s open hospital invoice, so there is one balance to
            settle at the desk. Billing staff see a single <strong>Tests</strong> line with a total
            — never the test names, which stay visible to the laboratory and to you.
          </>
        ) : (
          <>
            Tests are charged on their own lab invoice and paid at the lab counter. Billing staff do
            not see lab invoices at all, and lab takings are reported separately from the
            hospital&rsquo;s.
          </>
        )}
      </p>

      <label className="flex cursor-pointer items-start gap-2.5 rounded-md border border-border bg-surface px-3 py-2.5 text-sm">
        <input
          type="checkbox"
          checked={form.hasLab ?? true}
          onChange={(e) => setForm({ ...form, hasLab: e.target.checked })}
          className="mt-0.5 h-4 w-4"
        />
        <span>
          <span className="font-medium">This hospital has its own laboratory</span>
          <span className="mt-0.5 block text-xs text-text-muted">
            Turn off for a clinic that draws the blood and sends it out. Every test then leaves the
            building, and the worklist has nothing to show.
          </span>
        </span>
      </label>

      {form.hasLab !== false && (
        <div className="rounded-md border border-border bg-surface">
          <label className="flex cursor-pointer items-start gap-2.5 px-3 py-2.5 text-sm">
            <input
              type="checkbox"
              checked={form.acceptsExternalLabOrders ?? false}
              onChange={(e) => setForm({ ...form, acceptsExternalLabOrders: e.target.checked })}
              className="mt-0.5 h-4 w-4"
            />
            <span>
              <span className="font-medium">Accept test orders from other hospitals</span>
              <span className="mt-0.5 block text-xs text-text-muted">
                Makes you <em>findable</em> by a hospital that already has your code. They still
                have to add you deliberately — nobody can browse a list of laboratories. Off means
                you are not findable at all, and their attempt to add you is refused.
              </span>
            </span>
          </label>

          {form.acceptsExternalLabOrders && (
            <>
              <p className="border-t border-border px-3 py-2.5 text-xs text-text-muted">
                Give them the code at the top of this page. They add it under{' '}
                <strong>Partner labs</strong> at their end — nothing arrives until they do. Your
                report goes back onto their order, so they do not have to chase you for it.
              </p>

              {/*
                The money half of the same handshake, and a separate question
                from whether you will do the work at all.

                A laboratory with no accounts-receivable function genuinely
                cannot carry an institutional debt however willing it is to run
                the test; one with no counter cannot take money from a patient
                who was never told to come. Both are ordinary, and the sending
                hospital cannot know which without being told.
              */}
              <div className="border-t border-border px-3 py-2.5">
                <p className="text-sm font-medium text-text">Who may pay you for it</p>
                <p className="mb-2 mt-0.5 text-xs text-text-muted">
                  A hospital can only set up a partnership on terms you accept here. Turning one off
                  does not affect work already sent.
                </p>

                {BILLING_MODES.map((m) => {
                  const on = (form.acceptedReferralBilling ?? []).includes(m);
                  return (
                    <label key={m} className="flex cursor-pointer items-start gap-2 py-1">
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            acceptedReferralBilling: e.target.checked
                              ? [...(form.acceptedReferralBilling ?? []), m]
                              : (form.acceptedReferralBilling ?? []).filter((x) => x !== m),
                          })
                        }
                        className="mt-0.5 h-4 w-4"
                      />
                      <span>
                        <span className="text-sm">{BILLING_LABEL_INBOUND[m]}</span>
                        <span className="block text-xs text-text-muted">
                          {m === 'ORIGIN_PAYS'
                            ? 'You invoice the hospital that sent the work. The patient never deals with you.'
                            : 'The patient comes to your counter and pays you. The referring hospital charges nothing.'}
                        </span>
                      </span>
                    </label>
                  );
                })}

                {/*
                  An empty set is legal and means work accepted under no
                  arrangement, which is a real state while a lab is deciding —
                  but it is also indistinguishable from a mistake, so it says
                  what the consequence is rather than saving quietly.
                */}
                {(form.acceptedReferralBilling ?? []).length === 0 && (
                  <p className="mt-1 text-xs text-warning">
                    With neither ticked, no hospital can set up a partnership with you. Existing
                    ones stop being usable until you tick one back on.
                  </p>
                )}
              </div>
            </>
          )}
        </div>
      )}

      </>
      )}

      {/*
        Tax, and the switch that turns it on.
        --------------------------------------
        Hidden entirely without BILLING. A hospital that was never sold the
        ledger has nothing to tax through this product, and a switch whose
        save is refused is worse than no switch.
        Off by default, and explicit rather than inferred from "are any rates
        defined" — so a hospital can build its rate table on the Tax Rates
        screen, check it, and switch it on when it is ready. With it off,
        nothing is taxed and invoices are exactly what they were before this
        existed, which is where most clinics stay.
      */}
      {has('BILLING') && (
      <div className="rounded-md border border-border bg-surface">
        <label className="flex cursor-pointer items-start gap-2.5 px-3 py-2.5 text-sm">
          <input
            type="checkbox"
            checked={form.taxEnabled ?? false}
            onChange={(e) => setForm({ ...form, taxEnabled: e.target.checked })}
            className="mt-0.5 h-4 w-4"
          />
          <span>
            <span className="font-medium">Charge tax</span>
            <span className="mt-0.5 block text-xs text-text-muted">
              Off means nothing is taxed, whatever rates exist. Define the rates first under{' '}
              <strong>Tax Rates</strong>, then switch this on.
            </span>
          </span>
        </label>

        {form.taxEnabled && (
          <div className="space-y-3 border-t border-border px-3 py-3">
            {/*
              Inclusive vs exclusive is behaviour, not a display preference.
              In India the MRP on the box already contains GST and is the
              number the patient expects to pay. In the US the shelf price is
              net and tax is added at the till. Both are "the price is 10.00"
              and they mean different amounts of money.
            */}
            <Field
              label="The prices we enter"
              hint="India: MRP usually includes GST. United States: tax is added at the till."
            >
              <select
                className="w-full rounded-md border border-border bg-bg px-3 py-2 text-sm"
                value={form.pricesIncludeTax ? 'INCLUSIVE' : 'EXCLUSIVE'}
                onChange={(e) =>
                  setForm({ ...form, pricesIncludeTax: e.target.value === 'INCLUSIVE' })
                }
              >
                <option value="EXCLUSIVE">Are before tax — add tax at the till</option>
                <option value="INCLUSIVE">Already include tax — show the split on the bill</option>
              </select>
            </Field>

            {/*
              A separate rate for consultations, on purpose.

              Indian healthcare services are largely exempt while the medicines
              dispensed at the same visit are not — one rate covering both
              would be wrong for whichever was configured second. "No tax" is a
              real and common answer here, so it is the first option rather
              than an omission.
            */}
            <Field
              label="Tax on consultation fees"
              hint="Separate from medicines. In India healthcare services are usually exempt."
            >
              <select
                className="w-full rounded-md border border-border bg-bg px-3 py-2 text-sm"
                value={form.consultationTaxRateId ?? ''}
                onChange={(e) =>
                  setForm({
                    ...form,
                    consultationTaxRateId: e.target.value === '' ? null : Number(e.target.value),
                  })
                }
              >
                <option value="">No tax on consultations</option>
                {rates.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name} ({r.label})
                  </option>
                ))}
              </select>
            </Field>

            {/*
              An empty dropdown is indistinguishable from a missing feature.
              -------------------------------------------------------------
              With no rates defined this control collapses to its single
              "No tax" option, which reads as "this hospital cannot charge tax
              on consultations" rather than "nobody has defined a rate yet".
              Reported as exactly that misreading — the fifth time in this
              project that a control hidden by an empty list has been taken
              for an absent one.
            */}
            {rates.length === 0 && (
              <p className="rounded-sm border border-[#ecdca6] bg-warning-soft px-2.5 py-2 text-xs text-[#6b5314]">
                <strong>No tax rates defined yet.</strong> Create them under{' '}
                <Link href="/admin/tax" className="underline underline-offset-2">
                  Tax Rates
                </Link>{' '}
                — a name and a percentage, e.g. &ldquo;GST 12%&rdquo;. They then appear here for
                consultations, and on each medicine in the catalogue. Until one exists, nothing
                can be taxed.
              </p>
            )}

            <p className="text-xs text-text-subtle">
              Rates themselves are defined under{' '}
              <Link href="/admin/tax" className="text-primary underline-offset-2 hover:underline">
                Tax Rates
              </Link>
              . Medicines are taxed at their own rate, set per medicine on the Inventory screen.
              Anything unassigned uses whichever rate is marked default — never zero, so switching
              tax on does not silently under-charge a catalogue nobody has been through yet.
            </p>
          </div>
        )}
      </div>
      )}

      {changed ? (
        <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-text">
          Appointments already booked keep their existing times — only new bookings use the
          changed grid.
          {form.pharmacyBilling !== saved.pharmacyBilling ? (
            <>
              {' '}
              Invoices already raised keep the form they were raised in; only new sales use the
              changed setting.
            </>
          ) : null}
          {form.currency !== saved.currency ? (
            <>
              {' '}
              Changing the currency <strong>relabels</strong> existing invoices from{' '}
              {saved.currency} to {form.currency}; no amount is converted.
            </>
          ) : null}
        </p>
      ) : null}

      {error ? <p className="text-sm text-danger">{error}</p> : null}
      {notice ? <p className="text-sm text-success">{notice}</p> : null}

      <div className="flex gap-2">
        <Button variant="primary" disabled={!changed || busy} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save changes'}
        </Button>
        <Button variant="ghost" disabled={!changed || busy} onClick={() => setForm(saved)}>
          Discard
        </Button>
      </div>
      </div>
    </div>
  );
}
