import { useCallback, useMemo, useState } from 'react';
import { Alert, FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { api } from '@/lib/api';
import { useLiveData } from '@/lib/use-live-data';
import { useAuth } from '@/lib/auth-context';
import { statusColors, statusLabel, theme } from '@/lib/theme';
import { time } from '@/lib/format';
import { useMoney } from '@/lib/use-money';
import {
  AppHeader,
  Avatar,
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  Screen,
  StatusPill,
} from '@/components/ui';
import type { Appointment, AppointmentStatus } from '@/lib/types';

/**
 * Reception's schedule — any day, not just today.
 *
 * Check-in is the one task in the system that is genuinely *better* on a phone
 * than at a desk: you are standing in the waiting room next to the person you
 * are checking in.
 *
 * WHY THE DAY IS NAVIGABLE
 * ------------------------
 * The first version only ever asked the server for today, because check-in is
 * a today-only action and that is what the screen was built around. But a
 * receptionist is asked "can you move my Thursday appointment?" constantly, and
 * with no way to reach Thursday the answer was "not from this app". Rescheduling
 * and cancelling existed and were unreachable for every appointment except the
 * ones happening in the next few hours.
 *
 * WHY CHECK-IN DISAPPEARS ON OTHER DAYS
 * -------------------------------------
 * The status machine would happily accept it — SCHEDULED → CHECKED_IN carries
 * no date rule — but checking someone in for next Tuesday is meaningless, and a
 * mis-tap would put a patient in a waiting-room queue they are not standing in.
 * The buttons follow what the day *means*, not only what the API permits.
 */
export default function ScheduleScreen() {
  /*
   * The appointment book, for the roles the web gives it to.
   *
   * This screen was reception's and the *list* is exactly what a clinician
   * needs — the web gives DOCTOR and NURSE an Appointments item showing the
   * same `GET /appointments?date=`. What is reception's is the *acting*:
   * booking, checking in, marking a no-show and raising the invoice.
   *
   * So the day view opens to all three and the buttons do not. Building a
   * second, read-only appointment screen would have been two lists to keep
   * agreeing about the same rows.
   */
  const { user } = useAuth();
  const manages = user?.role === 'RECEPTIONIST';
  const money = useMoney();
  const timezone = user?.hospital?.timezone;

  /**
   * Today, in the *hospital's* timezone.
   *
   * Not the device's. A phone that has travelled, or is simply set wrong, would
   * otherwise open on a day the clinic is not having. `en-CA` is the locale
   * that formats as YYYY-MM-DD, which is what the API expects.
   */
  const today = useMemo(
    () => new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date()),
    [timezone],
  );

  const [date, setDate] = useState<string | null>(null);
  const activeDate = date ?? today;
  const isToday = activeDate === today;

  const [appointments, setAppointments] = useState<Appointment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api<{ data: Appointment[] }>(`/appointments?date=${activeDate}`);
      setAppointments(res.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the schedule');
      setAppointments([]);
    }
  }, [activeDate]);

  // Refetches on focus and every 15s. Returning from a reschedule showed the
  // old time until this existed, and a shared schedule that reads once tells
  // one receptionist something the rest of the desk already knows is wrong.
  useLiveData(load);

  const setStatus = async (appointment: Appointment, status: AppointmentStatus, verb: string) => {
    setBusyId(appointment.id);
    setError(null);
    try {
      const updated = await api<Appointment>(`/appointments/${appointment.id}/status`, {
        method: 'PATCH',
        body: { status },
      });
      // Patched in place rather than refetched: the receptionist is part-way
      // down a list and a reload would scroll them away from where they were.
      setAppointments((prev) =>
        (prev ?? []).map((a) => (a.id === updated.id ? { ...a, ...updated } : a)),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : `Could not ${verb} this appointment`);
    } finally {
      setBusyId(null);
    }
  };

  /**
   * Both destructive endings ask first.
   *
   * `CANCELLED` and `NO_SHOW` are terminal in the status machine — nothing
   * moves out of them, so an accidental tap cannot be undone from the app, only
   * by booking again. Check-in asks nothing, because it is the common action
   * and trivially reversible.
   */
  const confirmTerminal = (appointment: Appointment, status: 'CANCELLED' | 'NO_SHOW') => {
    const cancelling = status === 'CANCELLED';
    Alert.alert(
      cancelling ? 'Cancel this appointment?' : 'Mark as no-show?',
      `${appointment.patient?.fullName ?? 'This patient'} at ${time(appointment.scheduledAt)}.` +
        (cancelling ? '\n\nThis cannot be undone — the slot is released and would need rebooking.' : ''),
      [
        { text: 'Keep it', style: 'cancel' },
        {
          text: cancelling ? 'Cancel appointment' : 'Mark no-show',
          style: 'destructive',
          onPress: () => void setStatus(appointment, status, cancelling ? 'cancel' : 'update'),
        },
      ],
    );
  };

  /**
   * Raise the invoice for a patient who has arrived.
   *
   * Shown from check-in onwards, because that is the usual moment: the patient
   * arrives, pays at the desk, and waits to be seen. Billing only after the
   * consultation means chasing someone who has already left.
   *
   * OFFERED, NOT REQUIRED
   * ---------------------
   * Nothing depends on this having happened. The doctor sees the patient
   * whether or not they have paid, and the charge can be raised or settled
   * afterwards — a bill is still billable at IN_PROGRESS and COMPLETED.
   *
   * Reception raises the charge and reads the amount back. Whether they may
   * also *collect* it depends on whether this clinic gives them BILLING_STAFF
   * as a second role; the Invoices tab appears if so.
   */
  const raiseInvoice = async (appointment: Appointment) => {
    setBusyId(appointment.id);
    setError(null);
    try {
      const invoice = await api<{ id: number; totalAmount: string }>(
        `/appointments/${appointment.id}/invoice`,
        { method: 'POST' },
      );
      setAppointments((prev) =>
        (prev ?? []).map((a) => (a.id === appointment.id ? { ...a, invoice: { id: invoice.id } } : a)),
      );
      Alert.alert(
        'Invoice raised',
        `${money(invoice.totalAmount)} due from ${appointment.patient?.fullName ?? 'this patient'}.`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not raise the invoice');
    } finally {
      setBusyId(null);
    }
  };

  const waiting = (appointments ?? []).filter((a) => a.status === 'CHECKED_IN').length;
  const expected = (appointments ?? []).filter((a) => a.status === 'SCHEDULED').length;

  const subtitle = isToday
    ? `${expected} expected · ${waiting} waiting`
    : `${expected} booked · ${longDate(activeDate, timezone)}`;

  return (
    <Screen>
      <AppHeader
        title={isToday ? 'Today' : longDate(activeDate, timezone)}
        subtitle={subtitle}
        right={<Avatar name={user?.fullName ?? ''} onPress={() => router.push('/(tabs)/me')} />}
      />

      {error && <ErrorBanner message={error} />}

      <FlatList
        data={appointments ?? []}
        keyExtractor={(item) => String(item.id)}
        contentContainerStyle={s.list}
        ListHeaderComponent={
          <View style={s.controls}>
            <View style={s.dateBar}>
              <Button label="‹" variant="secondary" onPress={() => setDate(step(activeDate, -1))} />
              <Button
                label={isToday ? 'Today' : 'Back to today'}
                variant={isToday ? 'secondary' : 'primary'}
                onPress={() => setDate(null)}
                style={s.grow}
                disabled={isToday}
              />
              <Button label="›" variant="secondary" onPress={() => setDate(step(activeDate, 1))} />
            </View>
            {manages && (
              <Button
                label="+  Book appointment"
                onPress={() => router.push('/appointment/new')}
              />
            )}
          </View>
        }
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
        ListEmptyComponent={
          appointments === null ? null : (
            <EmptyState
              glyph="◷"
              title={isToday ? 'Nothing booked today' : 'Nothing booked this day'}
              body="Use Book to add an appointment."
            />
          )
        }
        renderItem={({ item }) => {
          const colors = statusColors(item.status);
          const busy = busyId === item.id;
          // Terminal states have no actions left — the machine allows nothing
          // out of COMPLETED, CANCELLED or NO_SHOW.
          const open = item.status === 'SCHEDULED' || item.status === 'CHECKED_IN';
          // The patient is in the building — CANCELLED and NO_SHOW never are,
          // and SCHEDULED has not turned up yet.
          const arrived =
            item.status === 'CHECKED_IN' ||
            item.status === 'IN_PROGRESS' ||
            item.status === 'COMPLETED';

          return (
            <Card style={s.card}>
              <View style={s.cardTop}>
                <Text style={s.slot} numberOfLines={1}>
                  {time(item.scheduledAt)}
                </Text>
                <StatusPill
                  label={statusLabel[item.status] ?? item.status}
                  bg={colors.bg}
                  fg={colors.fg}
                />
              </View>

              <Text style={s.name} numberOfLines={1}>
                {item.patient?.fullName ?? 'Unknown patient'}
              </Text>
              <Text style={s.muted} numberOfLines={1}>
                {item.doctor ? `Dr ${item.doctor.fullName} · ${item.doctor.specialization}` : '—'}
              </Text>
              {item.reason ? <Text style={s.reason}>{item.reason}</Text> : null}

              {/* Payment, from arrival onwards.
                  Whether a patient has paid is the thing reception is asked at
                  the desk, so both states are visible on the row rather than
                  behind a tap. */}
              {manages &&
                arrived &&
                (item.invoice ? (
                  <Text style={s.invoiced}>✓ Invoiced</Text>
                ) : (
                  <View style={s.actions}>
                    <Button
                      label={
                        item.doctor?.consultationFee
                          ? `Bill ${money(item.doctor.consultationFee)}`
                          : 'Bill consultation'
                      }
                      busy={busy}
                      onPress={() => void raiseInvoice(item)}
                      style={s.grow}
                    />
                  </View>
                ))}

              {open && manages && (
                <>
                  {/* Check-in and no-show are today's business only. */}
                  {isToday && item.status === 'SCHEDULED' && (
                    <View style={s.actions}>
                      <Button
                        label="Check in"
                        busy={busy}
                        onPress={() => void setStatus(item, 'CHECKED_IN', 'check in')}
                        style={s.grow}
                      />
                      <Button
                        label="No-show"
                        variant="danger"
                        disabled={busy}
                        onPress={() => confirmTerminal(item, 'NO_SHOW')}
                        style={s.grow}
                      />
                    </View>
                  )}

                  {/* Moving and cancelling apply on any day — they are the two
                      things people phone the front desk about. */}
                  <View style={s.actions}>
                    <Button
                      label="Reschedule"
                      variant="secondary"
                      disabled={busy}
                      onPress={() => router.push(`/appointment/${item.id}`)}
                      style={s.grow}
                    />
                    <Button
                      label="Cancel"
                      variant="danger"
                      disabled={busy}
                      onPress={() => confirmTerminal(item, 'CANCELLED')}
                      style={s.grow}
                    />
                  </View>
                </>
              )}
            </Card>
          );
        }}
      />
    </Screen>
  );
}

/** Steps a YYYY-MM-DD string. Plain date arithmetic — no timezone involved. */
function step(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** "Thu 28 Aug" — rendered in the hospital's zone, like everything else here. */
function longDate(date: string, timeZone?: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString([], {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(timeZone ? { timeZone } : {}),
  });
}

const s = StyleSheet.create({
  list: { padding: theme.space(4), gap: theme.space(3) },
  controls: { gap: theme.space(2) },
  dateBar: { flexDirection: 'row', gap: theme.space(2) },
  grow: { flex: 1 },
  card: { gap: theme.space(1) },
  cardTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.space(2),
  },
  slot: {
    ...theme.font.heading,
    color: theme.color.text,
    fontVariant: ['tabular-nums'],
    flexShrink: 1,
  },
  name: { ...theme.font.heading, color: theme.color.text, marginTop: theme.space(1) },
  muted: { ...theme.font.small, color: theme.color.textSubtle },
  reason: { ...theme.font.small, color: theme.color.textMuted, marginTop: theme.space(1) },
  actions: { flexDirection: 'row', gap: theme.space(2), marginTop: theme.space(2) },
  invoiced: {
    ...theme.font.caption,
    color: theme.color.success,
    marginTop: theme.space(2),
  },
});
