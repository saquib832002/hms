import { useCallback, useMemo, useState } from 'react';
import {
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { useLiveData } from '@/lib/use-live-data';
import { theme } from '@/lib/theme';
import { Button, Card, ErrorBanner, Screen } from '@/components/ui';
import type { ReferralBilling } from '@/lib/types';
import { BILLING_LABEL_INBOUND, BILLING_MODES } from '@/lib/referral-billing';
import {
  CURRENCIES,
  matchesZone,
  offsetLabel,
  symbolFor,
  timezones,
} from '@/lib/clinic-options';

/**
 * This hospital's clinic day, editable from a phone.
 *
 * WHY THESE ARE NOT PREFERENCES
 * -----------------------------
 * They generate the booking grid. The slot length decides which appointment
 * times exist; the timezone decides what "today" means on every queue in the
 * system. A hospital left on another's timezone gets a clinic day that ends
 * before its staff arrive and a booking page offering only past slots — which
 * presents as a bug in booking, not as a wrong setting. The screen says so,
 * because a setting that quietly reshapes the appointment book is worse than
 * one that explains itself.
 *
 * WHY IT IS ON MOBILE AT ALL
 * --------------------------
 * It is a five-field form, and currency in particular is the first thing a new
 * clinic needs to change — a hospital in India seeing pounds on every invoice
 * has a broken product until it is fixed, and requiring a laptop to fix it is
 * a poor first hour. Staff accounts and the audit browser stay on the web; a
 * short form does not need a desk.
 *
 * The tenant is never sent. It comes from the authenticated user's row, so an
 * admin edits their own hospital and only their own, however the request is
 * shaped.
 */

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

const FIELDS = [
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
] as const;

const hh = (h: number) => `${String(h).padStart(2, '0')}:00`;

export default function ClinicSettingsScreen() {
  const { user, refreshUser } = useAuth();
  const [saved, setSaved] = useState<ClinicSettings | null>(null);
  const [form, setForm] = useState<Partial<ClinicSettings>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState<'currency' | 'timezone' | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api<ClinicSettings>('/admin/clinic-settings');
      setSaved(res);
      // Only reset the form when nothing is being edited, so the 15s refresh
      // cannot wipe a half-typed change out from under someone.
      setForm((current) => (Object.keys(current).length === 0 ? res : current));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load settings');
    }
  }, []);

  useLiveData(load);

  const changed = saved !== null && FIELDS.some((k) => form[k] !== saved[k]);
  const currencyChanged = saved !== null && form.currency !== saved.currency;

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
        },
      });
      setSaved(res);
      setForm(res);
      // The currency and timezone on screen elsewhere come from the cached
      // session, not from this response. Without this the symbol stays stale
      // until the next sign-in, which reads as the save not having worked.
      await refreshUser();
      setNotice('Saved. New appointment slots use these settings from now on.');
    } catch (e) {
      // The server explains why — an end hour before the start, an unknown
      // timezone, a slot length that does not divide an hour.
      setError(e instanceof Error ? e.message : 'Could not save settings');
    } finally {
      setBusy(false);
    }
  }

  if (!saved) {
    return (
      <Screen>
        {error && <ErrorBanner message={error} />}
        <View style={s.loading}>
          <Text style={s.muted}>{error ? ' ' : 'Loading settings…'}</Text>
        </View>
      </Screen>
    );
  }

  const currency = form.currency ?? saved.currency;
  const timezone = form.timezone ?? saved.timezone;
  const pharmacyBilling = form.pharmacyBilling ?? saved.pharmacyBilling;
  const hasPharmacy = form.hasPharmacy ?? saved.hasPharmacy;
  const acceptsExternal = form.acceptsExternalPrescriptions ?? saved.acceptsExternalPrescriptions;
  const labBilling = form.labBilling ?? saved.labBilling;
  const hasLab = form.hasLab ?? saved.hasLab;
  const acceptsExternalLab = form.acceptsExternalLabOrders ?? saved.acceptsExternalLabOrders;
  const acceptedBilling = form.acceptedReferralBilling ?? saved.acceptedReferralBilling ?? [];

  /*
   * What this hospital was sold. A setting for a module they do not have is a
   * control whose write the server refuses — showing it is an invitation to
   * find that out the hard way.
   */
  const hasModule = (m: string) => user?.hospital.modules?.includes(m as never) ?? true;
  const taxEnabled = form.taxEnabled ?? saved.taxEnabled;

  return (
    <Screen>
      {error && <ErrorBanner message={error} />}

      <ScrollView
        contentContainerStyle={s.body}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={false} onRefresh={() => void load()} />}
      >
        <Card>
          <Text style={s.summary}>{saved.summary}</Text>
          <Text style={s.muted}>
            {saved.slotsPerDoctorPerDay} appointment slots per doctor per day
          </Text>

          {/*
            This hospital's code, shown unconditionally rather than beside the
            setting that consumes it. A hospital cannot decide whether to
            accept external prescriptions without knowing what it would be
            handing out, and the code identifies them to support regardless.

            It is also the only place this string appears anywhere: the vendor
            picks the slug at approval, nothing conveys it to the customer, and
            the login form has no hospital field.
          */}
          <View style={s.divider} />
          <Text style={s.muted}>
            Your hospital&rsquo;s code is <Text style={s.code}>{user?.hospital.slug}</Text>
          </Text>
          <Text style={s.rowHint}>
            Quote it to support, and give it to any hospital that wants to send prescriptions to
            your pharmacy.
          </Text>
        </Card>

        <Text style={s.group}>Money</Text>
        {/*
          The tax switch, and only the switch.

          Turning tax on or off is one tap and belongs on a phone — the same
          argument as currency. Defining the *rates* is not: that is an
          accounting decision taken once with figures to hand, so it stays on
          the web, and this screen says where. Showing a half-usable rate
          editor here would be worse than sending somebody to a desk.
        */}
        <Card>
          <View style={s.choiceRow}>
            <Button
              label={taxEnabled ? '✓ Charging tax' : 'No tax'}
              size="sm"
              variant={taxEnabled ? 'primary' : 'secondary'}
              onPress={() => setForm({ ...form, taxEnabled: !taxEnabled })}
            />
          </View>
          <Text style={s.rowHint}>
            {taxEnabled
              ? `Prices ${saved.pricesIncludeTax ? 'already include' : 'are before'} tax. Consultations are ${saved.consultationTaxRateId ? 'taxed at their own rate' : 'untaxed'}. Rates are set on the web, under Tax Rates.`
              : 'Nothing is taxed, whatever rates exist. Set the rates up on the web first, then switch this on.'}
          </Text>
        </Card>

        <Pressable onPress={() => setPicking('currency')}>
          <Card>
            <Text style={s.rowLabel}>Currency</Text>
            <Text style={s.rowValue}>
              {currency} · {symbolFor(currency)}
            </Text>
            <Text style={s.rowHint}>
              The symbol on every invoice and report. Changing it{' '}
              <Text style={s.emphasis}>relabels</Text> existing amounts — nothing is converted.
            </Text>
          </Card>
        </Pressable>

        <Text style={s.group}>The clinic day</Text>
        <Pressable onPress={() => setPicking('timezone')}>
          <Card>
            <Text style={s.rowLabel}>Timezone</Text>
            <Text style={s.rowValue}>
              {timezone.replace(/_/g, ' ')} {offsetLabel(timezone)}
            </Text>
            <Text style={s.rowHint}>
              The hospital&apos;s wall clock. It decides what &ldquo;today&rdquo; means on every
              queue.
            </Text>
          </Card>
        </Pressable>

        <Card style={s.spaced}>
          <Text style={s.rowLabel}>Slot length</Text>
          <View style={s.chips}>
            {saved.allowedSlotMinutes.map((m) => (
              <Chip
                key={m}
                label={`${m} min`}
                active={(form.slotMinutes ?? saved.slotMinutes) === m}
                onPress={() => setForm({ ...form, slotMinutes: m })}
              />
            ))}
          </View>
          <Text style={s.rowHint}>How long one appointment lasts.</Text>
        </Card>

        <Card style={s.spaced}>
          <Stepper
            label="Opens"
            value={form.clinicStartHour ?? saved.clinicStartHour}
            onChange={(clinicStartHour) => setForm({ ...form, clinicStartHour })}
          />
          <View style={s.divider} />
          <Stepper
            label="Closes"
            value={form.clinicEndHour ?? saved.clinicEndHour}
            onChange={(clinicEndHour) => setForm({ ...form, clinicEndHour })}
          />
          <Text style={s.rowHint}>The last slot begins before the closing hour.</Text>
        </Card>

        {/*
          The one setting that decides whether the pharmacy is a department or a
          business. Worded as a consequence rather than a label — "separate" and
          "combined" on their own do not tell an owner what will be different
          tomorrow morning.
        */}
        {/*
          Hidden for a hospital that was never sold the module. Not a security
          boundary — `ModuleGuard` refuses the write — but a lab-only tenant
          reading about dispensing modes is being shown the price list for
          something they did not buy.
        */}
        {hasModule('PHARMACY') && (
        <>
        <Card>
          <Text style={s.cardTitle}>Pharmacy billing</Text>

          <View style={s.choiceRow}>
            <Button
              label="Separate"
              size="sm"
              variant={pharmacyBilling === 'SEPARATE' ? 'primary' : 'secondary'}
              onPress={() => setForm({ ...form, pharmacyBilling: 'SEPARATE' })}
            />
            <Button
              label="Combined"
              size="sm"
              variant={pharmacyBilling === 'COMBINED' ? 'primary' : 'secondary'}
              onPress={() => setForm({ ...form, pharmacyBilling: 'COMBINED' })}
            />
          </View>

          <Text style={s.rowHint}>
            {pharmacyBilling === 'COMBINED'
              ? 'Medicines are added to the patient’s hospital invoice, so there is one balance to settle. Billing staff see a single Medicines line with a total — never the drug names, which stay visible to the pharmacist and to you.'
              : 'Medicines are charged on their own pharmacy invoice and paid at the pharmacy counter. Billing staff do not see pharmacy invoices at all, and pharmacy takings are reported separately.'}
          </Text>
        </Card>

        {/*
          Whether there is a pharmacy at all, and whether it takes outside
          work. The second is meaningless without the first, so it disappears
          when the first is off — and both disappear for a hospital that was
          never sold the module, where the write would be refused anyway.
        */}
        <Card>
          <Text style={s.cardTitle}>Pharmacy</Text>

          <View style={s.choiceRow}>
            <Button
              label={hasPharmacy ? '✓ We have a pharmacy' : 'No pharmacy here'}
              size="sm"
              variant={hasPharmacy ? 'primary' : 'secondary'}
              onPress={() => setForm({ ...form, hasPharmacy: !hasPharmacy })}
            />
          </View>
          <Text style={s.rowHint}>
            {hasPharmacy
              ? 'Doctors choose where each prescription goes.'
              : 'Doctors are not asked — every prescription is handed to the patient, and the dispensing screens have nothing to show.'}
          </Text>

          {hasPharmacy && (
            <>
              <View style={s.choiceRow}>
                <Button
                  label={acceptsExternal ? '✓ Accept from other hospitals' : 'Own patients only'}
                  size="sm"
                  variant={acceptsExternal ? 'primary' : 'secondary'}
                  onPress={() =>
                    setForm({ ...form, acceptsExternalPrescriptions: !acceptsExternal })
                  }
                />
              </View>
              <Text style={s.rowHint}>
                Makes you findable by a hospital that already has your code. They still have to
                add you deliberately — nobody can browse a list of pharmacies. Off means you are
                not findable at all.
              </Text>

              {/*
                The other half of the agreement, named rather than left to be
                inferred from nothing happening. The code itself is at the top
                of this screen, readable whether or not this is switched on.
              */}
              {acceptsExternal && (
                <Text style={s.rowHint}>
                  Give them the code at the top of this screen. They add it under Partner
                  pharmacies at their end — nothing arrives until they do.
                </Text>
              )}
            </>
          )}
        </Card>

        {/*
          The laboratory, on exactly the same three questions.
          ---------------------------------------------------
          Separate from the pharmacy's, not folded in with it. A hospital may
          run one, both or neither, and a single "accept work from other
          hospitals" would mean a clinic wanting to take in bloods had also
          agreed to dispense other people's prescriptions.

          This was missing when the lab shipped, which made every attempt to add
          a partner lab fail with "no lab is accepting orders under that code" —
          a correct refusal naming a precondition nothing in the product could
          satisfy.
        */}
        </>
        )}

        {hasModule('LABORATORY') && (
        <>
        <Card>
          <Text style={s.cardTitle}>Lab billing</Text>

          <View style={s.choiceRow}>
            <Button
              label="Separate"
              size="sm"
              variant={labBilling === 'SEPARATE' ? 'primary' : 'secondary'}
              onPress={() => setForm({ ...form, labBilling: 'SEPARATE' })}
            />
            <Button
              label="Combined"
              size="sm"
              variant={labBilling === 'COMBINED' ? 'primary' : 'secondary'}
              onPress={() => setForm({ ...form, labBilling: 'COMBINED' })}
            />
          </View>

          <Text style={s.rowHint}>
            {labBilling === 'COMBINED'
              ? 'Tests are added to the patient’s hospital invoice, so there is one balance to settle. Billing staff see a single Tests line with a total — never the test names, which stay visible to the laboratory and to you.'
              : 'Tests are charged on their own lab invoice and paid at the lab counter. Billing staff do not see lab invoices at all, and lab takings are reported separately.'}
          </Text>
        </Card>

        <Card>
          <Text style={s.cardTitle}>Laboratory</Text>

          <View style={s.choiceRow}>
            <Button
              label={hasLab ? '✓ We have a lab' : 'No lab here'}
              size="sm"
              variant={hasLab ? 'primary' : 'secondary'}
              onPress={() => setForm({ ...form, hasLab: !hasLab })}
            />
          </View>
          <Text style={s.rowHint}>
            {hasLab
              ? 'Doctors choose where each test is run.'
              : 'Every test leaves the building, and the worklist has nothing to show. This is the ordinary setting for a clinic that draws the blood and sends it out.'}
          </Text>

          {hasLab && (
            <>
              <View style={s.choiceRow}>
                <Button
                  label={acceptsExternalLab ? '✓ Accept from other hospitals' : 'Own patients only'}
                  size="sm"
                  variant={acceptsExternalLab ? 'primary' : 'secondary'}
                  onPress={() =>
                    setForm({ ...form, acceptsExternalLabOrders: !acceptsExternalLab })
                  }
                />
              </View>
              <Text style={s.rowHint}>
                Makes you findable by a hospital that already has your code. They still have to add
                you deliberately — nobody can browse a list of laboratories. Off means you are not
                findable at all, and their attempt to add you is refused.
              </Text>

              {acceptsExternalLab && (
                <>
                  <Text style={s.rowHint}>
                    Give them the code at the top of this screen. They add it under Partner labs at
                    their end — nothing arrives until they do. Your report goes back onto their
                    order, so they do not have to chase you for it.
                  </Text>

                  {/*
                    The money half of the same handshake, and a separate
                    question from whether you will do the work at all.

                    A laboratory with no accounts-receivable function cannot
                    carry an institutional debt however willing it is to run the
                    test; one with no counter cannot take money from a patient
                    who was never told to come. The sending hospital has no way
                    to know which without being told, and gets refused on save
                    if it guesses wrong.
                  */}
                  <Text style={s.subheading}>Who may pay you for it</Text>
                  <View style={s.choiceRow}>
                    {BILLING_MODES.map((m) => {
                      const on = acceptedBilling.includes(m);
                      return (
                        <Button
                          key={m}
                          label={`${on ? '✓ ' : ''}${BILLING_LABEL_INBOUND[m]}`}
                          size="sm"
                          variant={on ? 'primary' : 'secondary'}
                          onPress={() =>
                            setForm({
                              ...form,
                              acceptedReferralBilling: on
                                ? acceptedBilling.filter((x) => x !== m)
                                : [...acceptedBilling, m],
                            })
                          }
                        />
                      );
                    })}
                  </View>

                  {/*
                    An empty set is legal and means work accepted under no
                    arrangement — a real state while a lab is deciding, and
                    indistinguishable from a mistake, so the consequence is
                    stated rather than saved quietly.
                  */}
                  <Text style={acceptedBilling.length === 0 ? s.warnHint : s.rowHint}>
                    {acceptedBilling.length === 0
                      ? 'With neither on, no hospital can set up a partnership with you, and existing ones stop being usable until you turn one back on.'
                      : 'A hospital can only set up a partnership on terms you accept here. Turning one off does not affect work already sent.'}
                  </Text>
                </>
              )}
            </>
          )}
        </Card>

        </>
        )}

        {changed && (
          <View style={s.warn}>
            <Text style={s.warnText}>
              Appointments already booked keep their existing times — only new bookings use the
              changed grid.
              {currencyChanged
                ? ` Changing the currency relabels existing invoices from ${saved.currency} to ${currency}; no amount is converted.`
                : ''}
              {pharmacyBilling !== saved.pharmacyBilling
                ? ' Invoices already raised keep the form they were raised in; only new sales use the changed setting.'
                : ''}
            </Text>
          </View>
        )}

        {notice && (
          <View style={s.notice}>
            <Text style={s.noticeText}>{notice}</Text>
          </View>
        )}

        <View style={s.actions}>
          <Button label="Save changes" onPress={() => void save()} disabled={!changed} busy={busy} />
          <Button
            label="Discard"
            variant="secondary"
            disabled={!changed || busy}
            onPress={() => {
              setForm(saved);
              setNotice(null);
            }}
          />
        </View>

        <Text style={s.footnote}>
          These apply to {user?.hospital?.name ?? 'this hospital'} only.
        </Text>
      </ScrollView>

      {picking === 'currency' && (
        <PickerSheet
          title="Currency"
          onClose={() => setPicking(null)}
          options={CURRENCIES.map((c) => ({
            value: c.code,
            title: `${c.code} · ${symbolFor(c.code)}`,
            subtitle: c.name,
          }))}
          selected={currency}
          onSelect={(code) => {
            setForm({ ...form, currency: code });
            setPicking(null);
          }}
        />
      )}

      {picking === 'timezone' && (
        <PickerSheet
          title="Timezone"
          searchable
          searchPlaceholder="Country or city — e.g. India, Chicago"
          onClose={() => setPicking(null)}
          options={timezones(timezone).map((z) => ({
            value: z,
            title: z.replace(/_/g, ' '),
            subtitle: offsetLabel(z),
            match: (q: string) => matchesZone(z, q),
          }))}
          selected={timezone}
          onSelect={(zone) => {
            setForm({ ...form, timezone: zone });
            setPicking(null);
          }}
          emptyHint="Zones are named after cities — India is listed as Asia/Calcutta on most systems."
        />
      )}
    </Screen>
  );
}

/* ─────────────────────────────── pieces ─────────────────────────────── */

function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[s.chip, active ? s.chipActive : null]}>
      <Text style={[s.chipText, active ? s.chipTextActive : null]}>{label}</Text>
    </Pressable>
  );
}

/**
 * Hours as a stepper rather than a 24-item picker.
 *
 * Wraps at both ends, so 23 → 00 and 00 → 23. Clamping instead would strand
 * someone one tap away from the value they want with nothing telling them why
 * the button stopped working.
 */
function Stepper({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <View style={s.stepper}>
      <Text style={s.rowLabel}>{label}</Text>
      <View style={s.stepperControls}>
        <Pressable style={s.stepperButton} onPress={() => onChange((value + 23) % 24)}>
          <Text style={s.stepperGlyph}>−</Text>
        </Pressable>
        <Text style={s.stepperValue}>{hh(value)}</Text>
        <Pressable style={s.stepperButton} onPress={() => onChange((value + 1) % 24)}>
          <Text style={s.stepperGlyph}>+</Text>
        </Pressable>
      </View>
    </View>
  );
}

interface PickerOption {
  value: string;
  title: string;
  subtitle?: string;
  match?: (query: string) => boolean;
}

function PickerSheet({
  title,
  options,
  selected,
  onSelect,
  onClose,
  searchable,
  searchPlaceholder,
  emptyHint,
}: {
  title: string;
  options: PickerOption[];
  selected: string;
  onSelect: (value: string) => void;
  onClose: () => void;
  searchable?: boolean;
  searchPlaceholder?: string;
  emptyHint?: string;
}) {
  const [query, setQuery] = useState('');

  const shown = useMemo(() => {
    if (!query.trim()) return options;
    return options.filter((o) =>
      o.match ? o.match(query) : `${o.title} ${o.subtitle ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()),
    );
  }, [options, query]);

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <View style={s.modalRoot}>
        <Pressable style={s.modalBackdrop} onPress={onClose} />
        <View style={s.modalCard}>
          <Text style={s.modalTitle}>{title}</Text>

          {searchable && (
            <TextInput
              style={s.search}
              value={query}
              onChangeText={setQuery}
              placeholder={searchPlaceholder}
              placeholderTextColor={theme.color.textSubtle}
              autoCorrect={false}
              autoCapitalize="none"
            />
          )}

          <ScrollView style={s.optionList} keyboardShouldPersistTaps="handled">
            {shown.map((o) => (
              <Pressable
                key={o.value}
                onPress={() => onSelect(o.value)}
                style={({ pressed }) => [
                  s.option,
                  o.value === selected ? s.optionActive : null,
                  pressed ? s.optionPressed : null,
                ]}
              >
                <View style={{ flex: 1 }}>
                  <Text style={s.optionTitle}>{o.title}</Text>
                  {o.subtitle ? <Text style={s.optionSub}>{o.subtitle}</Text> : null}
                </View>
                {o.value === selected && <Text style={s.optionTick}>✓</Text>}
              </Pressable>
            ))}
            {shown.length === 0 && emptyHint && <Text style={s.emptyHint}>{emptyHint}</Text>}
          </ScrollView>

          <Button label="Close" variant="secondary" onPress={onClose} />
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  body: { padding: theme.space(3), paddingBottom: theme.space(8) },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  muted: { ...theme.font.small, color: theme.color.textMuted },
  summary: { ...theme.font.title, color: theme.color.text },
  group: {
    ...theme.font.caption,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: theme.color.textSubtle,
    marginTop: theme.space(4),
    marginBottom: theme.space(2),
  },
  spaced: { marginTop: theme.space(2) },
  rowLabel: { ...theme.font.caption, color: theme.color.textMuted, textTransform: 'uppercase' },
  rowValue: { ...theme.font.title, color: theme.color.text, marginTop: theme.space(1) },
  cardTitle: {
    ...theme.font.caption,
    color: theme.color.textMuted,
    textTransform: 'uppercase',
    marginBottom: theme.space(2),
  },
  choiceRow: { flexDirection: 'row', gap: theme.space(2), marginBottom: theme.space(2) },
  /* Nested in rowHint, so it inherits size and line height and only changes
     weight and family — this gets read out over a phone, and the whole point
     is that it is picked out from the sentence around it. */
  code: {
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
    fontWeight: '600',
    color: theme.color.text,
  },
  rowHint: {
    ...theme.font.caption,
    color: theme.color.textSubtle,
    lineHeight: 16,
    marginTop: theme.space(1),
  },
  emphasis: { color: theme.color.text, fontWeight: '700' },
  subheading: {
    ...theme.font.caption,
    color: theme.color.text,
    fontWeight: '700',
    marginTop: theme.space(3),
  },
  warnHint: {
    ...theme.font.caption,
    color: theme.color.warning,
    lineHeight: 16,
    marginTop: theme.space(1),
  },

  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space(2), marginTop: theme.space(2) },
  chip: {
    paddingHorizontal: theme.space(3),
    paddingVertical: theme.space(2),
    borderRadius: theme.radius.full,
    borderWidth: 1,
    borderColor: theme.color.border,
    backgroundColor: theme.color.bg,
  },
  chipActive: { backgroundColor: theme.color.text, borderColor: theme.color.text },
  chipText: { ...theme.font.small, color: theme.color.textMuted },
  chipTextActive: { color: theme.color.onSolid },

  stepper: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  stepperControls: { flexDirection: 'row', alignItems: 'center', gap: theme.space(2) },
  stepperButton: {
    width: 40,
    height: 40,
    borderRadius: theme.radius.sm,
    borderWidth: 1,
    borderColor: theme.color.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepperGlyph: { ...theme.font.title, color: theme.color.text },
  stepperValue: {
    ...theme.font.title,
    color: theme.color.text,
    minWidth: 58,
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
  },
  divider: {
    height: 1,
    backgroundColor: theme.color.border,
    marginVertical: theme.space(2),
  },

  warn: {
    marginTop: theme.space(3),
    backgroundColor: theme.color.warningSoft,
    borderRadius: theme.radius.sm,
    padding: theme.space(3),
  },
  warnText: { ...theme.font.small, color: theme.color.warning, lineHeight: 18 },
  notice: {
    marginTop: theme.space(3),
    backgroundColor: theme.color.successSoft,
    borderRadius: theme.radius.sm,
    padding: theme.space(3),
  },
  noticeText: { ...theme.font.small, color: theme.color.success, lineHeight: 18 },

  actions: { marginTop: theme.space(4), gap: theme.space(2) },
  footnote: {
    ...theme.font.caption,
    color: theme.color.textSubtle,
    textAlign: 'center',
    marginTop: theme.space(4),
  },

  modalRoot: { flex: 1, justifyContent: 'flex-end' },
  modalBackdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(17,26,20,0.45)' },
  modalCard: {
    backgroundColor: theme.color.surface,
    borderTopLeftRadius: theme.radius.lg,
    borderTopRightRadius: theme.radius.lg,
    padding: theme.space(4),
    paddingBottom: theme.space(6),
    maxHeight: '85%',
  },
  modalTitle: { ...theme.font.title, color: theme.color.text, marginBottom: theme.space(2) },
  search: {
    ...theme.font.input,
    color: theme.color.text,
    backgroundColor: theme.color.bg,
    borderWidth: 1,
    borderColor: theme.color.border,
    borderRadius: theme.radius.sm,
    paddingHorizontal: theme.space(3),
    paddingVertical: theme.space(2),
    marginBottom: theme.space(2),
  },
  optionList: { marginBottom: theme.space(3) },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: theme.space(2),
    paddingHorizontal: theme.space(2),
    borderRadius: theme.radius.sm,
  },
  optionActive: { backgroundColor: theme.color.surfaceSunken },
  optionPressed: { opacity: 0.55 },
  optionTitle: { ...theme.font.body, color: theme.color.text },
  optionSub: { ...theme.font.caption, color: theme.color.textSubtle },
  optionTick: { ...theme.font.title, color: theme.color.text },
  emptyHint: {
    ...theme.font.caption,
    color: theme.color.textSubtle,
    lineHeight: 16,
    padding: theme.space(2),
  },
});
