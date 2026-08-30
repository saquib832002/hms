import { useCallback, useMemo, useState } from 'react';
import {
  Modal,
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
  slotsPerDoctorPerDay: number;
  summary: string;
  allowedSlotMinutes: number[];
}

const FIELDS = ['timezone', 'slotMinutes', 'clinicStartHour', 'clinicEndHour', 'currency'] as const;

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
        </Card>

        <Text style={s.group}>Money</Text>
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

        {changed && (
          <View style={s.warn}>
            <Text style={s.warnText}>
              Appointments already booked keep their existing times — only new bookings use the
              changed grid.
              {currencyChanged
                ? ` Changing the currency relabels existing invoices from ${saved.currency} to ${currency}; no amount is converted.`
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
  rowHint: {
    ...theme.font.caption,
    color: theme.color.textSubtle,
    lineHeight: 16,
    marginTop: theme.space(1),
  },
  emphasis: { color: theme.color.text, fontWeight: '700' },

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
