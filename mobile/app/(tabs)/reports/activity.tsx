import { useCallback, useState } from 'react';
import {
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { useLiveData } from '@/lib/use-live-data';
import { useMoney } from '@/lib/use-money';
import { theme } from '@/lib/theme';
import { time } from '@/lib/format';
import { AppHeader, Button, Card, ErrorBanner, Screen } from '@/components/ui';
import { MonthCalendar } from '@/components/calendar';
import { statusLabel } from '@/lib/theme';
import type { AppointmentStatus, ConsultationLedger, StaffActivityReport } from '@/lib/types';

/**
 * A day in the clinic, one row per member of staff.
 *
 * The owner's question, and a fair one: who worked, how much did they do, and
 * how much money came in through them. In a practice small enough that the
 * owner is also on the rota, that is not surveillance — it is how the person
 * carrying the risk reconciles the day.
 *
 * THE DRILL-DOWN IS THE CONSULTATION LEDGER
 * -----------------------------------------
 * Each doctor's counts open the patients behind them: time, name, whether they
 * attended, what they were charged, whether they paid.
 *
 * Tapping a *row* used to open that person's audit trail instead. That was
 * removed — the audit log is a list of API actions (`PATIENT_CREATE`,
 * `QUEUE_VIEW`), and an owner reading it learns what the application called,
 * not what their staff did. Engineering vocabulary behind an ordinary tap makes
 * a management screen feel like a debugging tool. The audit browser remains on
 * the web for the compliance question it actually answers.
 *
 * WHAT IS STILL DELIBERATELY NOT HERE
 * -----------------------------------
 * Anything clinical: why they came, what was found, what was prescribed. The
 * ledger carries attendance and money — the same facts reception sees at the
 * desk. An owner who needs the clinical detail switches to a role that holds
 * it, from the header, and the audit log records they read it as a doctor.
 */
export default function DailyActivityScreen() {
  const { user } = useAuth();
  const fmt = useMoney();
  const timezone = user?.hospital?.timezone;

  /** Today on the *hospital's* clock, not the phone's. `en-CA` gives YYYY-MM-DD. */
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date());

  const [date, setDate] = useState(today);
  const [picking, setPicking] = useState(false);
  const [report, setReport] = useState<StaffActivityReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Which count was tapped — the patients behind it. */
  const [ledger, setLedger] = useState<{
    doctorId: number;
    title: string;
    status?: AppointmentStatus;
  } | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setReport(await api<StaffActivityReport>(`/admin/reports/staff-activity?date=${date}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the day');
    }
  }, [date]);

  useLiveData(load);

  return (
    <Screen>
      <AppHeader
        title={date === today ? 'Today' : longDate(date, timezone)}
        subtitle={report ? `${report.timezone}` : 'Loading…'}
      />

      {error && <ErrorBanner message={error} />}

      <ScrollView
        contentContainerStyle={s.body}
        refreshControl={<RefreshControl refreshing={false} onRefresh={() => void load()} />}
      >
        <View style={s.dateBar}>
          <Button label="‹" variant="secondary" size="sm" onPress={() => setDate(shift(date, -1))} />
          <Pressable style={s.datePick} onPress={() => setPicking(true)}>
            <Text style={s.dateText}>{longDate(date, timezone)}</Text>
          </Pressable>
          <Button
            label="›"
            variant="secondary"
            size="sm"
            disabled={date >= today}
            onPress={() => setDate(shift(date, 1))}
          />
        </View>

        <Text style={s.notice}>
          Counts and money only — no patient is named here. To see who was treated, switch to a
          clinical role you hold; that view is recorded against the role you were acting as.
        </Text>

        {report && (
          <>
            <Group title="Doctors" empty="No doctors on the rota.">
              {report.doctors.map((d) => (
                <View key={d.userId} style={s.doctorBlock}>
                  <Row
                    name={d.fullName}
                    sub={d.specialization}
                    figures={[]}
                    // Billed and collected side by side. Payment is never
                    // required before a consultation, so the gap is real.
                    money={`${fmt(d.revenue.collected)} of ${fmt(d.revenue.billed)}`}
                    warn={d.revenue.collected !== d.revenue.billed}
                  />
                  {/* Every count opens the patients behind it. A number an
                      owner cannot check is one they have to take on trust,
                      which is the opposite of why they opened this. */}
                  <View style={s.counts}>
                    <CountChip
                      label="seen"
                      value={d.consultations.completed}
                      onPress={() =>
                        setLedger({
                          doctorId: d.doctorId,
                          status: 'COMPLETED',
                          title: `${d.fullName} · seen`,
                        })
                      }
                    />
                    <CountChip
                      label="booked"
                      value={d.consultations.booked}
                      onPress={() =>
                        setLedger({ doctorId: d.doctorId, title: `${d.fullName} · all` })
                      }
                    />
                    <CountChip
                      label="no-show"
                      value={d.consultations.noShow}
                      tone={theme.color.danger}
                      onPress={() =>
                        setLedger({
                          doctorId: d.doctorId,
                          status: 'NO_SHOW',
                          title: `${d.fullName} · did not attend`,
                        })
                      }
                    />
                  </View>
                </View>
              ))}
            </Group>

            <Group title="Reception" empty="Nobody holds the reception role.">
              {report.reception.map((r) => (
                <Row
                  key={r.userId}
                  name={r.fullName}
                  figures={[
                    `${r.registrations} registered`,
                    `${r.bookings} booked`,
                    `${r.updates} check-ins`,
                    `${r.invoicesRaised} billed`,
                  ]}
                />
              ))}
            </Group>

            <Group title="Billing" empty="Nobody holds the billing role.">
              {report.billing.map((b) => (
                <Row
                  key={b.userId}
                  name={b.fullName}
                  figures={[
                    `${b.count} payment${b.count === 1 ? '' : 's'}`,
                    ...(b.refunds > 0
                      ? [`${b.refunds} refund${b.refunds === 1 ? '' : 's'}`]
                      : []),
                  ]}
                  sub={
                    [
                      // Gross both ways, under the net. A day that took a lot
                      // and gave a lot back should not look like a quiet one.
                      b.refunds > 0 ? `${fmt(b.total)} in · ${fmt(b.refunded)} back` : null,
                      b.methods.length
                        ? b.methods.map((m) => `${titleise(m.method)} ${fmt(m.amount)}`).join(' · ')
                        : null,
                    ]
                      .filter(Boolean)
                      .join('\n') || undefined
                  }
                  money={fmt(b.net)}
                />
              ))}
            </Group>

            <Group title="Pharmacy" empty="Nobody holds the pharmacy role.">
              {report.pharmacy.map((p) => (
                <Row
                  key={p.userId}
                  name={p.fullName}
                  figures={[`${p.dispensed} dispensed`, `${p.stockReceived} stock in`]}
                />
              ))}
            </Group>

            <Group title="Nursing" empty="Nobody holds the nursing role.">
              {report.nursing.map((n) => (
                <Row
                  key={n.userId}
                  name={n.fullName}
                  figures={[`${n.vitals} vitals`, `${n.doses} doses`, `${n.admissions} bed moves`]}
                />
              ))}
            </Group>

            <Text style={s.footnote}>
              Tap anyone to see their actions for the day. The full audit browser is on the web.
            </Text>
          </>
        )}
      </ScrollView>

      {picking && (
        <Modal visible animationType="slide" transparent onRequestClose={() => setPicking(false)}>
          <View style={s.modalRoot}>
            <Pressable style={s.modalBackdrop} onPress={() => setPicking(false)} />
            <View style={s.modalCard}>
              <MonthCalendar
                value={date}
                onChange={(next) => {
                  setDate(next);
                  setPicking(false);
                }}
                max={today}
              />
              <Button label="Close" variant="secondary" onPress={() => setPicking(false)} />
            </View>
          </View>
        </Modal>
      )}

      {ledger && (
        <LedgerSheet
          date={date}
          doctorId={ledger.doctorId}
          status={ledger.status}
          title={ledger.title}
          onClose={() => setLedger(null)}
        />
      )}

    </Screen>
  );
}

/* ────────────────────────── consultation ledger ────────────────────────── */

/**
 * The patients behind a number.
 *
 * WHAT IS HERE AND WHY IT IS ALLOWED
 * ----------------------------------
 * Name, time, attendance, what was charged and whether it was paid. Every one
 * of those is already on reception's screen at the desk and billing's invoice
 * list — the same information, gathered by doctor and day so an owner can
 * reconcile their clinic.
 *
 * WHAT IS NOT
 * -----------
 * Why they came, what was found, what was prescribed. `Appointment.reason` is
 * typed by reception at booking and is routinely "chest pain"; it sits on the
 * same record as everything above and the API deliberately does not fetch it.
 *
 * "Rx" is a tick, not a list. That a prescription was issued is a fact about
 * the consultation; what is in it names a condition.
 */
function LedgerSheet({
  date,
  doctorId,
  status,
  title,
  onClose,
}: {
  date: string;
  doctorId: number;
  status?: AppointmentStatus;
  title: string;
  onClose: () => void;
}) {
  const fmt = useMoney();
  const [data, setData] = useState<ConsultationLedger | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const qs = new URLSearchParams({ date, doctorId: String(doctorId) });
      if (status) qs.set('status', status);
      setData(await api<ConsultationLedger>(`/admin/reports/consultations?${qs}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the list');
    }
  }, [date, doctorId, status]);

  useLiveData(load);

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <View style={s.modalRoot}>
        <Pressable style={s.modalBackdrop} onPress={onClose} />
        <View style={s.modalCard}>
          <Text style={s.modalTitle}>{title}</Text>
          <Text style={s.modalHint}>
            {data ? `${data.total} on ${date}` : date} · attendance and charges only. For records
            or prescriptions, switch to a clinical role.
          </Text>

          {error && <Text style={s.error}>{error}</Text>}

          <ScrollView style={s.logList}>
            {(data?.appointments ?? []).map((a) => (
              <View key={a.id} style={s.ledgerRow}>
                <Text style={s.logTime}>{time(a.scheduledAt)}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={s.ledgerName} numberOfLines={1}>
                    {a.patient.fullName}
                  </Text>
                  <Text style={s.ledgerSub}>
                    {statusLabel[a.status] ?? a.status}
                    {a.prescriptionIssued ? ' · Rx issued' : ''}
                  </Text>
                </View>
                <View style={{ alignItems: 'flex-end' }}>
                  {/* Not billed and billed zero are different facts. */}
                  <Text style={s.ledgerMoney}>
                    {a.invoice ? fmt(a.invoice.total) : 'not billed'}
                  </Text>
                  {a.invoice ? (
                    <Text
                      style={[
                        s.ledgerPaid,
                        { color: a.invoice.settled ? theme.color.success : theme.color.warning },
                      ]}
                    >
                      {a.invoice.settled ? 'paid' : `${fmt(a.invoice.outstanding)} due`}
                    </Text>
                  ) : null}
                </View>
              </View>
            ))}
            {data?.total === 0 && <Text style={s.modalHint}>Nothing on this day.</Text>}
          </ScrollView>

          <Button label="Close" variant="secondary" onPress={onClose} />
        </View>
      </View>
    </Modal>
  );
}

/* ───────────────────────────── drill-down ───────────────────────────── */

/* ─────────────────────────────── pieces ─────────────────────────────── */

function Group({
  title,
  empty,
  children,
}: {
  title: string;
  empty: string;
  children: React.ReactNode[];
}) {
  return (
    <>
      <Text style={s.group}>{title}</Text>
      <Card>
        {children.length === 0 ? <Text style={s.muted}>{empty}</Text> : children}
      </Card>
    </>
  );
}

function Row({
  name,
  sub,
  figures,
  money,
  warn,
}: {
  name: string;
  sub?: string;
  figures: (string | null)[];
  money?: string;
  warn?: boolean;
}) {
  /*
   * Not tappable, deliberately.
   *
   * Rows used to open that person's audit trail for the day. It was removed:
   * the audit log is a list of API actions — `PATIENT_CREATE`,
   * `APPOINTMENT_STATUS_CHANGE` — and an owner reading it learns what the
   * application called, not what their staff did. The tappable things on this
   * screen are the counts, which open real patients.
   */
  return (
    <View style={s.row}>
      <View style={{ flex: 1 }}>
        <Text style={s.rowName} numberOfLines={1}>
          {name}
        </Text>
        <Text style={s.rowFigures} numberOfLines={1}>
          {figures.filter(Boolean).join(' · ')}
        </Text>
        {sub ? (
          <Text style={s.rowSub} numberOfLines={1}>
            {sub}
          </Text>
        ) : null}
      </View>
      <View style={s.rowRight}>
        {money ? (
          <Text style={[s.rowMoney, warn ? { color: theme.color.warning } : null]}>{money}</Text>
        ) : null}
      </View>
    </View>
  );
}

/**
 * A count, and a way to check it.
 *
 * Zero is not tappable. There is nothing behind it, and a chip that opens an
 * empty sheet teaches people the chips do not work.
 */
function CountChip({
  label,
  value,
  tone,
  onPress,
}: {
  label: string;
  value: number;
  tone?: string;
  onPress: () => void;
}) {
  const dead = value === 0;
  return (
    <Pressable
      disabled={dead}
      onPress={onPress}
      style={({ pressed }) => [s.chip, dead ? s.chipDead : null, pressed ? s.pressed : null]}
    >
      <Text style={[s.chipValue, tone && !dead ? { color: tone } : null]}>{value}</Text>
      <Text style={s.chipLabel}>{label}</Text>
    </Pressable>
  );
}

/* ─────────────────────────────── dates ─────────────────────────────── */

/** Day arithmetic on the string itself, so no timezone can shift it. */
function shift(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function longDate(date: string, timeZone?: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: timeZone ?? 'UTC',
  }).format(new Date(Date.UTC(y, m - 1, d, 12)));
}

function titleise(value: string): string {
  return value
    .split('_')
    .map((w) => w.charAt(0) + w.slice(1).toLowerCase())
    .join(' ');
}

const s = StyleSheet.create({
  body: { padding: theme.space(3), paddingBottom: theme.space(8) },
  muted: { ...theme.font.small, color: theme.color.textMuted },

  dateBar: { flexDirection: 'row', alignItems: 'center', gap: theme.space(2) },
  datePick: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: theme.space(2),
    borderRadius: theme.radius.sm,
    borderWidth: 1,
    borderColor: theme.color.border,
    backgroundColor: theme.color.surface,
  },
  dateText: { ...theme.font.body, color: theme.color.text },

  notice: {
    ...theme.font.caption,
    color: theme.color.textSubtle,
    lineHeight: 16,
    marginTop: theme.space(3),
  },
  group: {
    ...theme.font.caption,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: theme.color.textSubtle,
    marginTop: theme.space(4),
    marginBottom: theme.space(2),
  },

  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: theme.space(2) },
  pressed: { opacity: 0.6 },
  rowName: { ...theme.font.body, color: theme.color.text, fontWeight: '600' },
  rowFigures: { ...theme.font.caption, color: theme.color.textMuted, marginTop: 1 },
  rowSub: { ...theme.font.caption, color: theme.color.textSubtle, marginTop: 1 },
  rowRight: { alignItems: 'flex-end' },
  rowMoney: { ...theme.font.body, color: theme.color.text, fontVariant: ['tabular-nums'] },
  rowDenied: { ...theme.font.caption, color: theme.color.danger, marginTop: 2 },

  footnote: {
    ...theme.font.caption,
    color: theme.color.textSubtle,
    textAlign: 'center',
    marginTop: theme.space(4),
    lineHeight: 16,
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
  modalTitle: { ...theme.font.title, color: theme.color.text },
  modalHint: { ...theme.font.caption, color: theme.color.textMuted, marginTop: theme.space(1) },
  error: { ...theme.font.small, color: theme.color.danger, marginTop: theme.space(2) },

  logList: { marginVertical: theme.space(3) },
  logRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.space(2),
    paddingVertical: theme.space(2),
    borderTopWidth: 1,
    borderTopColor: theme.color.border,
  },
  logTime: {
    ...theme.font.caption,
    color: theme.color.textSubtle,
    fontVariant: ['tabular-nums'],
    width: 54,
  },
  logAction: { ...theme.font.caption, color: theme.color.text },

  doctorBlock: { borderTopWidth: 1, borderTopColor: theme.color.border, paddingTop: theme.space(1) },
  counts: { flexDirection: 'row', gap: theme.space(2), paddingBottom: theme.space(2) },
  chip: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: theme.space(2),
    borderRadius: theme.radius.sm,
    borderWidth: 1,
    borderColor: theme.color.border,
    backgroundColor: theme.color.surfaceSunken,
  },
  chipDead: { opacity: 0.45, backgroundColor: 'transparent' },
  chipValue: { ...theme.font.title, color: theme.color.text, fontVariant: ['tabular-nums'] },
  chipLabel: { ...theme.font.caption, color: theme.color.textSubtle },

  ledgerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space(2),
    paddingVertical: theme.space(2),
    borderTopWidth: 1,
    borderTopColor: theme.color.border,
  },
  ledgerName: { ...theme.font.body, color: theme.color.text, fontWeight: '600' },
  ledgerSub: { ...theme.font.caption, color: theme.color.textSubtle },
  ledgerMoney: { ...theme.font.caption, color: theme.color.text, fontVariant: ['tabular-nums'] },
  ledgerPaid: { ...theme.font.caption, fontVariant: ['tabular-nums'] },
  logTarget: { ...theme.font.caption, color: theme.color.textSubtle },
  logDenied: { ...theme.font.caption, color: theme.color.danger },
});
