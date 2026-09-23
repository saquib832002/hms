import { useCallback, useState } from 'react';
import {
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
  ViewStyle,
} from 'react-native';
import { router } from 'expo-router';
import { api } from '@/lib/api';
import { useLiveData } from '@/lib/use-live-data';
import { theme } from '@/lib/theme';
import { relativeAge } from '@/lib/format';
import { AppHeader, Button, Card, ErrorBanner, Field, Screen } from '@/components/ui';
import type {
  AdminDashboard,
  DoctorReport,
  DoctorReportRow,
  FinanceReport,
  TenantModule,
} from '@/lib/types';
import { useAuth } from '@/lib/auth-context';
import { useMoney } from '@/lib/use-money';

/**
 * Administrator overview — read-only aggregates.
 *
 * Nothing on this screen identifies a patient, and there is nowhere to tap
 * through to one. That is not an oversight: `CLAUDE.md` puts ADMIN outside
 * clinical access, and a phone that could reach a patient record from a
 * management summary would quietly undo that.
 *
 * ONE WRITE ACTION, AND WHY IT IS THE EXCEPTION
 * ---------------------------------------------
 * Setting a doctor's consultation fee. Everything else administrative — staff
 * accounts, departments, voiding an invoice — stays on the web, because those
 * are decisions that deserve a desk and a moment's thought.
 *
 * The fee is different in kind: it is a single number that *blocks somebody
 * else's work right now*. Reception's checkout refuses for an unpriced doctor,
 * and the receptionist discovers it standing in front of a patient. Requiring
 * the owner to find a laptop to unblock a queue is the wrong trade, and in a
 * small clinic the owner is often the doctor being priced, holding a phone.
 *
 * The fee edit is admin-only server-side regardless of what this screen shows —
 * `PATCH /doctors/:id` is `@Roles(ADMIN)` and audited as
 * `DOCTOR_PROFILE_UPDATE`. This is the affordance, not the boundary.
 *
 * WHAT IS HERE AND WHAT STAYS ON THE WEB
 * --------------------------------------
 * Mobile is a curated subset, not feature parity. The questions an owner asks
 * standing in their own clinic — what have we taken today, is anyone unpriced,
 * who is busy — are here. Invoice aging, the twelve-month trend and anything
 * you would reconcile against a bank statement stay on the web app, because
 * that is reading and cross-checking rather than glancing.
 */
export default function OverviewScreen() {
  const fmt = useMoney();
  const { user } = useAuth();
  /*
   * The owner's overview is the floor — every tenant has one — and nearly every
   * card on it belonged to a module. A pharmacy-only tenant read appointments,
   * occupancy and a doctors list, all empty, and nothing about the shop it
   * runs. Zeroes for something never bought read as breakage.
   */
  const has = (m: TenantModule) => user?.hospital.modules?.includes(m) ?? true;
  const clinic = has('CLINIC');
  const wards = has('WARDS');
  const billing = has('BILLING');
  const pharmacy = has('PHARMACY');
  const laboratory = has('LABORATORY');
  const [dashboard, setDashboard] = useState<AdminDashboard | null>(null);
  const [finance, setFinance] = useState<FinanceReport | null>(null);
  const [doctors, setDoctors] = useState<DoctorReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [fetchedAt, setFetchedAt] = useState<Date | null>(null);
  const [pricing, setPricing] = useState<DoctorReportRow | null>(null);

  /**
   * Three independent fetches, and a failure in one must not blank the others.
   *
   * WHY `allSettled` AND NOT `all`
   * ------------------------------
   * This was `Promise.all`, and the consequence was worse than a missing panel.
   * Everything below renders inside `{dashboard && …}`, so when the two newer
   * report endpoints 404'd — a backend that had not been restarted after they
   * were added — the whole screen went blank: no occupancy, no staff, and no
   * link to the screens that *were* working. The app looked like the feature
   * had never been built, which is exactly how it was reported.
   *
   * A screen composed of independent panels should degrade one panel at a time.
   * `allSettled` gives each its own outcome, so an older client against a newer
   * server, or the reverse, loses a card rather than the tab.
   */
  const load = useCallback(async () => {
    // Six months rather than twelve: a phone shows six bars legibly and the
    // web app is where a full year gets read properly.
    const [d, f, doc] = await Promise.allSettled([
      api<AdminDashboard>('/admin/dashboard'),
      api<FinanceReport>('/admin/reports/finance?months=6'),
      api<DoctorReport>('/admin/reports/doctors'),
    ]);

    if (d.status === 'fulfilled') setDashboard(d.value);
    if (f.status === 'fulfilled') setFinance(f.value);
    if (doc.status === 'fulfilled') setDoctors(doc.value);
    setFetchedAt(new Date());

    /*
     * Reported, never silent. A partial screen that says nothing is a screen
     * someone reads as "we took no money today" — the failure mode this whole
     * report set exists to avoid. The dashboard failing is the one that leaves
     * nothing usable, so it is named first.
     */
    const failed = [
      d.status === 'rejected' ? 'overview' : null,
      f.status === 'rejected' ? 'takings' : null,
      doc.status === 'rejected' ? 'doctors' : null,
    ].filter(Boolean);

    setError(
      failed.length === 0
        ? null
        : `Could not load ${failed.join(', ')}. The server may need restarting after an update.`,
    );
  }, []);

  // Refetches on focus and every 15s. These are the day's running totals.
  useLiveData(load);

  return (
    <Screen>
      {/* Was a literal `{relativeAge(fetchedAt)}` inside quotes — a template
          that never interpolated, so the subtitle read the source of itself. */}
      <AppHeader title="Overview" subtitle={`Updated ${relativeAge(fetchedAt)}`} />

      {error && <ErrorBanner message={error} />}

      <ScrollView
        contentContainerStyle={s.body}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => {
              setRefreshing(true);
              await load();
              setRefreshing(false);
            }}
          />
        }
      >
        {dashboard && (
          <>
            <Text style={s.group}>Today</Text>
            <View style={s.row}>
              {clinic && <Metric label="Appointments" value={dashboard.appointments.today} />}
              {clinic && (
                <Metric
                  label="Completed"
                  value={dashboard.appointments.completedToday}
                  tone={theme.color.success}
                />
              )}
              {/* What left the shelf, and whether any of it was uncharged —
                  the two questions a shop owner opens this screen with. */}
              {pharmacy && <Metric label="Dispensed" value={dashboard.pharmacy.dispensesToday} />}
              {pharmacy && (
                <Metric
                  label="Unpriced"
                  value={dashboard.pharmacy.unpricedSalesToday}
                  tone={
                    dashboard.pharmacy.unpricedSalesToday > 0 ? theme.color.warning : undefined
                  }
                />
              )}
              {laboratory && (
                <Metric label="Tests ordered" value={dashboard.laboratory.ordersToday} />
              )}
              {/* Resulted but not authorised: finished from the bench and
                  invisible to the doctor who asked. */}
              {laboratory && (
                <Metric
                  label="To authorise"
                  value={dashboard.laboratory.awaitingAuthorisation}
                  tone={
                    dashboard.laboratory.awaitingAuthorisation > 0
                      ? theme.color.warning
                      : undefined
                  }
                />
              )}
            </View>

            {/* Takings, counted from payments actually received — not from
                invoices raised, which is a different number that looks the
                same and moves at roughly the same times. */}
            {/*
              NET is the headline, not gross.
              -----------------------------
              This showed `collected.today`, so a payment refunded in full still
              read as money taken — while billing's payments ledger, which is
              signed, showed nothing for the same day. Two screens disagreeing
              about one day is worse than either being wrong alone.

              Gross in and gross out stay underneath: reconciling against a bank
              statement needs them, because a day that took 5,000 and refunded
              500 is not the same day as one that took 4,500.
            */}
            {billing && (
            <>
            <Text style={s.group}>Money in</Text>
            <Card>
              <Text style={s.muted}>Kept today</Text>
              <Text style={[s.big, { color: theme.color.success }]}>
                {finance ? fmt(finance.net.today) : '—'}
              </Text>
              <Text style={s.muted}>
                {finance
                  ? `${fmt(finance.collected.today)} in · ${fmt(finance.refunded.today)} back · ${
                      finance.collected.paymentsToday
                    } payments`
                  : ' '}
              </Text>
              <Text style={s.muted}>
                {finance ? `${fmt(finance.net.thisMonth)} kept this month` : ' '}
              </Text>
            </Card>

            {finance && finance.monthly.length > 0 && <Trend report={finance} fmt={fmt} />}

            {finance && (
              <>
                <Text style={s.group}>How it arrived, today</Text>
                <Card>
                  {/* Every method, including the ones at zero. "No card
                      payments today" and "the card row is missing" look
                      identical, and only one of them means the till balances. */}
                  {finance.methods.map((m) => (
                    <View key={m.method} style={s.line}>
                      <Text style={s.lineLabel}>{titleiseMethod(m.method)}</Text>
                      <Text style={[s.lineValue, m.today.count === 0 ? s.lineZero : null]}>
                        {fmt(m.today.amount)}
                      </Text>
                    </View>
                  ))}
                </Card>
              </>
            )}

            <Text style={s.group}>Owed</Text>
            <Card>
              <Text style={s.muted}>Outstanding</Text>
              {/* The hospital's own currency, not a hard-coded £. */}
              <Text style={s.big}>{fmt(dashboard.finance.outstanding)}</Text>
              <Text style={s.muted}>
                {dashboard.finance.openInvoices} open
                {finance && finance.aging.totalOverdue !== '0.00'
                  ? ` · ${fmt(finance.aging.totalOverdue)} overdue`
                  : ''}
              </Text>
            </Card>
            </>
            )}

            {wards && (
            <>
            <Text style={s.group}>Occupancy</Text>
            <Card>
              <Text
                style={[
                  s.big,
                  dashboard.occupancy.percent > 90 ? { color: theme.color.danger } : null,
                ]}
              >
                {dashboard.occupancy.percent}%
              </Text>
              <Text style={s.muted}>
                {dashboard.occupancy.occupied} of {dashboard.occupancy.beds} beds ·{' '}
                {dashboard.occupancy.available} free
              </Text>
            </Card>
            </>
            )}

            {clinic && doctors && <Doctors report={doctors} fmt={fmt} onPrice={setPricing} />}

            <Text style={s.group}>Staff and access</Text>
            <View style={s.row}>
              <Metric label="Active" value={dashboard.staff.active} />
              <Metric
                label="Locked out"
                value={dashboard.staff.lockedOut}
                tone={dashboard.staff.lockedOut > 0 ? theme.color.warning : undefined}
              />
              <Metric
                label="Denied 24h"
                value={dashboard.security.deniedRequestsLastDay}
                tone={dashboard.security.deniedRequestsLastDay > 20 ? theme.color.danger : undefined}
              />
            </View>

          </>
        )}

        {/*
          Navigation, outside the data guard.
          ----------------------------------
          These were inside `{dashboard && …}`, so when the figures failed to
          load the way *out* of this screen disappeared with them — and the
          admin's other screens read as unbuilt rather than unreachable. A link
          does not depend on a number, and should never be hidden by one.
        */}
        <Text style={s.group}>Reports</Text>
        <NavCard
          title="Daily activity"
          subtitle="Who worked, how much they did, and what came in — any day"
          onPress={() => router.push('/reports/activity')}
        />

        <Text style={s.group}>Configuration</Text>
        <NavCard
          title="Clinic settings"
          subtitle="Currency, timezone, slot length and opening hours"
          onPress={() => router.push('/settings/clinic')}
        />
        <NavCard
          title="Staff roles"
          subtitle="Who may act as what — one role at a time, switched by them"
          onPress={() => router.push('/settings/staff')}
          style={s.spaced}
        />

        <Text style={s.footnote}>
          Aggregates only. Invoice aging, the full revenue trend, staff management and the full
          audit browser are on the web app.
        </Text>
      </ScrollView>

      {pricing && (
        <FeeSheet
          doctor={pricing}
          onClose={() => setPricing(null)}
          onSaved={() => {
            setPricing(null);
            void load();
          }}
        />
      )}
    </Screen>
  );
}

/* ────────────────────────────── fee editor ────────────────────────────── */

/**
 * Set or clear one doctor's consultation fee.
 *
 * BLANK IS NOT ZERO, AND THE SHEET SAYS SO
 * ----------------------------------------
 * Clearing the fee means "cannot be billed at checkout"; zero means "this
 * consultation is free" and bills as such. Collapsing them would make a
 * forgotten price look like a decision, and the first anyone would know is a
 * month of unbilled work. Both are offered explicitly rather than left to be
 * inferred from an empty box.
 *
 * The amount is validated here for the message and on the server for the
 * guarantee. Sent as a string, like every amount in this system — a JSON
 * number has already been through float representation by the time it lands.
 */
function FeeSheet({
  doctor,
  onClose,
  onSaved,
}: {
  doctor: DoctorReportRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [value, setValue] = useState(doctor.consultationFee ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async (amount: string) => {
    if (amount !== '' && !/^\d{1,8}(\.\d{1,2})?$/.test(amount)) {
      setError('Enter an amount like 500 or 500.00.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api(`/doctors/${doctor.id}`, {
        method: 'PATCH',
        body: { consultationFee: amount },
      });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the fee');
      setSaving(false);
    }
  };

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <View style={s.modalRoot}>
        <Pressable style={s.modalBackdrop} onPress={onClose} />
        <View style={s.modalCard}>
          <Text style={s.modalName}>{doctor.fullName}</Text>
          <Text style={s.muted}>
            {doctor.specialization}
            {doctor.department ? ` · ${doctor.department}` : ''}
          </Text>

          <View style={{ marginTop: theme.space(3) }}>
            <Field
              label="Consultation fee"
              value={value}
              onChange={setValue}
              placeholder="e.g. 500"
              keyboardType="decimal-pad"
            />
          </View>

          <Text style={s.modalHint}>
            Reception uses this to bill a consultation at check-in. Clearing it stops them being
            able to — which is different from setting it to zero, meaning the consultation is free.
          </Text>

          {error && (
            <View style={s.modalError}>
              <Text style={s.modalErrorText}>{error}</Text>
            </View>
          )}

          <View style={{ marginTop: theme.space(3), gap: theme.space(2) }}>
            <Button label="Save fee" onPress={() => void save(value.trim())} busy={saving} />
            {doctor.consultationFee !== null && (
              <Button
                label="Clear fee"
                variant="danger"
                disabled={saving}
                onPress={() => void save('')}
              />
            )}
            <Button label="Cancel" variant="secondary" disabled={saving} onPress={onClose} />
          </View>
        </View>
      </View>
    </Modal>
  );
}

function NavCard({
  title,
  subtitle,
  onPress,
  style,
}: {
  title: string;
  subtitle: string;
  onPress: () => void;
  style?: ViewStyle;
}) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [style, pressed ? { opacity: 0.6 } : null]}>
      <Card>
        <View style={s.linkRow}>
          <View style={{ flex: 1 }}>
            <Text style={s.linkTitle}>{title}</Text>
            <Text style={s.linkSub}>{subtitle}</Text>
          </View>
          <Text style={s.linkChevron}>›</Text>
        </View>
      </Card>
    </Pressable>
  );
}

/* ─────────────────────────────── trend ─────────────────────────────── */

function Trend({ report, fmt }: { report: FinanceReport; fmt: (v: string) => string }) {
  const peak = report.monthly.reduce(
    (max, m) => (biggerMoney(m.collected, max) ? m.collected : max),
    '0.00',
  );

  if (peak === '0.00') return null;

  return (
    <>
      <Text style={s.group}>Collected, last {report.monthly.length} months</Text>
      <Card>
        <View style={s.chart}>
          {report.monthly.map((m) => (
            <View key={m.month} style={s.bar}>
              <View style={s.barTrack}>
                <View style={[s.barFill, { height: `${barHeight(m.collected, peak)}%` }]} />
              </View>
              {/* Just the month letter-group — a phone has no room for a year,
                  and the axis is contiguous so the year is never ambiguous. */}
              <Text style={s.barLabel}>{m.label.slice(0, 3)}</Text>
            </View>
          ))}
        </View>
        <Text style={s.muted}>
          Peak {fmt(peak)} · {report.monthly[report.monthly.length - 1].label}{' '}
          {fmt(report.monthly[report.monthly.length - 1].collected)}
        </Text>
      </Card>
    </>
  );
}

/* ─────────────────────────────── doctors ─────────────────────────────── */

function Doctors({
  report,
  fmt,
  onPrice,
}: {
  report: DoctorReport;
  fmt: (v: string) => string;
  onPrice: (doctor: DoctorReportRow) => void;
}) {
  return (
    <>
      <Text style={s.group}>Doctors · {report.total}</Text>

      {report.withoutFee > 0 && (
        /* Surfaced rather than left to be discovered. A doctor with no fee
           breaks reception's checkout, and the receptionist finds out standing
           in front of the patient. */
        <View style={s.warn}>
          <Text style={s.warnText}>
            {report.withoutFee} {report.withoutFee === 1 ? 'doctor has' : 'doctors have'} no
            consultation fee. Reception cannot bill for them — tap to set one.
          </Text>
        </View>
      )}

      <Card>
        {report.doctors.map((d, i) => (
          <Pressable
            key={d.id}
            onPress={() => onPrice(d)}
            style={({ pressed }) => [
              s.doctor,
              i > 0 ? s.doctorDivider : null,
              pressed ? s.doctorPressed : null,
            ]}
          >
            <View style={s.doctorName}>
              <Text style={s.doctorTitle} numberOfLines={1}>
                {d.fullName}
              </Text>
              <Text
                style={[s.doctorSub, d.consultationFee === null ? s.doctorUnpriced : null]}
                numberOfLines={1}
              >
                {d.specialization}
                {d.consultationFee === null ? ' · no fee set' : ` · ${fmt(d.consultationFee)}`}
              </Text>
            </View>
            <View style={s.doctorFigures}>
              <Text style={s.doctorCount}>
                {d.today.completed}/{d.today.booked}
              </Text>
              {/* Collected, not billed. Payment is never required before a
                  consultation, so the two genuinely differ and only one of
                  them is money the clinic has. */}
              <Text style={s.doctorMoney}>{fmt(d.revenueThisMonth.collected)}</Text>
            </View>
          </Pressable>
        ))}
        <Text style={s.legend}>
          Today completed / booked · collected this month. Tap a doctor to set their fee.
        </Text>
      </Card>
    </>
  );
}

/* ─────────────────────────────── helpers ─────────────────────────────── */

/**
 * Compares two canonical money strings without turning either into a number.
 *
 * Both come from the server's `fromMinor`, so they always carry exactly two
 * decimals and no separators — which makes "longer wins, otherwise
 * lexicographic" exactly right for non-negative amounts, and keeps `Number()`
 * out of a file that handles money. The comparison would be harmless; the habit
 * is what turns into `Number(a) + Number(b)` three months later.
 */
function biggerMoney(a: string, b: string): boolean {
  if (a.length !== b.length) return a.length > b.length;
  return a > b;
}

/** Bar height as a percentage of the tallest month. A pixel ratio, not an amount. */
function barHeight(value: string, peak: string): number {
  const minor = (v: string) => Number(v.replace('.', ''));
  const max = minor(peak);
  if (max === 0) return 0;
  return Math.max(Math.round((minor(value) / max) * 100), 1);
}

function titleiseMethod(method: string): string {
  return method
    .split('_')
    .map((w) => w.charAt(0) + w.slice(1).toLowerCase())
    .join(' ');
}

function Metric({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <View style={s.metric}>
      <Text style={[s.metricValue, tone ? { color: tone } : null]}>{value}</Text>
      <Text style={s.metricLabel}>{label}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  muted: { ...theme.font.small, color: theme.color.textMuted },
  body: { padding: theme.space(3), paddingBottom: theme.space(6) },
  group: {
    ...theme.font.caption,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: theme.color.textSubtle,
    marginTop: theme.space(3),
    marginBottom: theme.space(2),
  },
  row: { flexDirection: 'row', gap: theme.space(2) },
  metric: {
    flex: 1,
    backgroundColor: theme.color.surface,
    borderRadius: theme.radius.sm,
    borderWidth: 1,
    borderColor: theme.color.border,
    paddingVertical: theme.space(3),
    alignItems: 'center',
  },
  metricValue: { ...theme.font.display, color: theme.color.text },
  metricLabel: { ...theme.font.caption, color: theme.color.textMuted, textTransform: 'uppercase' },
  big: { ...theme.font.hero, color: theme.color.text, letterSpacing: -0.5 },

  // Method split
  line: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: theme.space(1),
  },
  lineLabel: { ...theme.font.body, color: theme.color.text },
  lineValue: { ...theme.font.body, color: theme.color.text, fontVariant: ['tabular-nums'] },
  lineZero: { color: theme.color.textSubtle },

  // Trend
  chart: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: theme.space(1),
    height: 92,
    marginBottom: theme.space(2),
  },
  bar: { flex: 1, alignItems: 'center' },
  barTrack: { width: '100%', height: 72, justifyContent: 'flex-end' },
  barFill: {
    width: '100%',
    // Green, matching "collected today" above. Not the role accent: the bars
    // are money in, and that reads the same colour everywhere on this screen.
    backgroundColor: theme.color.success,
    borderTopLeftRadius: 3,
    borderTopRightRadius: 3,
  },
  barLabel: { ...theme.font.caption, color: theme.color.textSubtle, marginTop: theme.space(1) },

  // Doctors
  warn: {
    backgroundColor: theme.color.warningSoft,
    borderRadius: theme.radius.sm,
    padding: theme.space(2),
    marginBottom: theme.space(2),
  },
  warnText: { ...theme.font.small, color: theme.color.warning },
  doctor: { flexDirection: 'row', alignItems: 'center', paddingVertical: theme.space(2) },
  doctorDivider: { borderTopWidth: 1, borderTopColor: theme.color.border },
  doctorPressed: { opacity: 0.55 },
  doctorName: { flex: 1, paddingRight: theme.space(2) },
  doctorTitle: { ...theme.font.body, color: theme.color.text, fontWeight: '600' },
  doctorSub: { ...theme.font.caption, color: theme.color.textSubtle },
  doctorUnpriced: { color: theme.color.warning },
  doctorFigures: { alignItems: 'flex-end' },
  doctorCount: { ...theme.font.body, color: theme.color.text, fontVariant: ['tabular-nums'] },
  doctorMoney: {
    ...theme.font.caption,
    color: theme.color.textMuted,
    fontVariant: ['tabular-nums'],
  },
  legend: {
    ...theme.font.caption,
    color: theme.color.textSubtle,
    marginTop: theme.space(2),
  },

  footnote: {
    ...theme.font.caption,
    color: theme.color.textSubtle,
    textAlign: 'center',
    marginTop: theme.space(5),
    lineHeight: 17,
  },

  spaced: { marginTop: theme.space(2) },
  linkRow: { flexDirection: 'row', alignItems: 'center' },
  linkTitle: { ...theme.font.body, color: theme.color.text, fontWeight: '600' },
  linkSub: { ...theme.font.caption, color: theme.color.textSubtle, marginTop: 2 },
  linkChevron: { ...theme.font.title, color: theme.color.textSubtle },

  // Fee sheet
  modalRoot: { flex: 1, justifyContent: 'flex-end' },
  modalBackdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(17,26,20,0.45)' },
  modalCard: {
    backgroundColor: theme.color.surface,
    borderTopLeftRadius: theme.radius.lg,
    borderTopRightRadius: theme.radius.lg,
    padding: theme.space(4),
    paddingBottom: theme.space(6),
  },
  modalName: { ...theme.font.title, color: theme.color.text },
  modalHint: {
    ...theme.font.caption,
    color: theme.color.textMuted,
    lineHeight: 16,
    marginTop: theme.space(1),
  },
  modalError: {
    marginTop: theme.space(2),
    backgroundColor: theme.color.dangerSoft,
    borderRadius: theme.radius.sm,
    padding: theme.space(2),
  },
  modalErrorText: { ...theme.font.small, color: theme.color.danger },
});
