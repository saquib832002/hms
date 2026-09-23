'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import type { AppointmentStatus, ConsultationLedger, StaffActivityReport } from '@/lib/types';
import { Sheet } from '@/components/ui/sheet';
import { dateTime } from '@/lib/format';
import { Button, Card, ErrorState, Skeleton } from '@/components/ui/primitives';
import { useMoney } from '@/lib/use-money';
import { useUser } from '@/lib/auth-context';

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
 * Every count on the doctors table opens the patients behind it: time, name,
 * whether they attended, what they were charged, whether they paid. A number an
 * owner cannot check is a number they have to take on trust, which is the
 * opposite of why they opened the screen.
 *
 * It used to drill into the audit trail instead. That was removed — the audit
 * log is a list of API actions (`PATIENT_CREATE`, `QUEUE_VIEW`), and an owner
 * reading it learns what the application called, not what their staff did.
 * Engineering vocabulary behind an ordinary link makes a management screen feel
 * like a debugging tool. The audit browser still exists under its own nav item,
 * for the compliance question it actually answers.
 *
 * WHAT IS STILL DELIBERATELY NOT HERE
 * -----------------------------------
 * Anything clinical: why they came, what was found, what was prescribed. The
 * ledger carries attendance and money — the same facts reception sees at the
 * desk and billing sees on an invoice. An owner who needs the clinical detail
 * switches to a role that holds it, and the audit log records that they read it
 * as a doctor.
 */
export default function DailyActivityPage() {
  const fmt = useMoney();
  const user = useUser();
  const [date, setDate] = useState(() => todayIn(user.hospital.timezone));
  const [report, setReport] = useState<StaffActivityReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Which count was clicked — the drill-down into the patients behind it. */
  const [ledger, setLedger] = useState<{
    doctorId?: number;
    title: string;
    status?: AppointmentStatus;
  } | null>(null);

  const load = useCallback(async () => {
    setReport(null);
    setError(null);
    try {
      setReport(await api<StaffActivityReport>(`/admin/reports/staff-activity?date=${date}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the day');
    }
  }, [date]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error && !report) return <ErrorState message={error} onRetry={() => void load()} />;

  const isToday = date === todayIn(user.hospital.timezone);

  return (
    <div className="scroll-thin flex-1 overflow-y-auto bg-surface">
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-surface px-4 py-2">
        <Button size="sm" variant="ghost" onClick={() => setDate(shift(date, -1))}>
          ← Previous
        </Button>
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="rounded-md border border-border bg-surface px-2 py-1 text-sm"
        />
        <Button size="sm" variant="ghost" disabled={isToday} onClick={() => setDate(shift(date, 1))}>
          Next →
        </Button>
        {!isToday && (
          <Button size="sm" variant="ghost" onClick={() => setDate(todayIn(user.hospital.timezone))}>
            Today
          </Button>
        )}
        <span className="ml-auto text-xs text-text-muted">
          {user.hospital.name} · {report?.timezone ?? user.hospital.timezone}
        </span>
      </div>

      <div className="p-4">
        <p className="mb-3 text-sm text-text-muted">
          Counts and money only — no patient is named on this screen. To see who was treated,
          switch to a clinical role you hold; that view is recorded against the role you were
          acting as.
        </p>

        {!report ? (
          <Skeleton className="h-64 w-full" />
        ) : (
          <div className="space-y-3">
            <Section
              title="Doctors"
              empty="No doctors on the rota."
              rows={report.doctors}
              head={['Doctor', 'Booked', 'Completed', 'No-show', 'Billed', 'Collected']}
              render={(d) => (
                <>
                  <Td>
                    <div className="font-medium">{d.fullName}</div>
                    <div className="text-xxs text-text-subtle">{d.specialization}</div>
                  </Td>
                  {/* Every count opens the patients behind it. A number an
                      owner cannot check is a number they have to take on
                      trust, which is the opposite of why they opened this. */}
                  <Td mono>
                    <Count
                      value={d.consultations.booked}
                      onClick={() =>
                        setLedger({ doctorId: d.doctorId, title: `${d.fullName} · all appointments` })
                      }
                    />
                  </Td>
                  <Td mono>
                    <Count
                      value={d.consultations.completed}
                      onClick={() =>
                        setLedger({
                          doctorId: d.doctorId,
                          status: 'COMPLETED',
                          title: `${d.fullName} · seen`,
                        })
                      }
                    />
                  </Td>
                  <Td mono muted={d.consultations.noShow === 0}>
                    <Count
                      value={d.consultations.noShow}
                      onClick={() =>
                        setLedger({
                          doctorId: d.doctorId,
                          status: 'NO_SHOW',
                          title: `${d.fullName} · did not attend`,
                        })
                      }
                    />
                  </Td>
                  <Td mono>{fmt(d.revenue.billed)}</Td>
                  {/* Billed and collected side by side. Payment is never
                      required before a consultation, so the gap is real. */}
                  <Td mono className={d.revenue.collected !== d.revenue.billed ? 'text-warning' : ''}>
                    {fmt(d.revenue.collected)}
                  </Td>
                </>
              )}
            />

            <Section
              title="Reception"
              empty="Nobody holds the reception role."
              rows={report.reception}
              head={['Person', 'Registered', 'Booked', 'Check-ins & changes', 'Invoices raised']}
              render={(r) => (
                <>
                  <Td>{r.fullName}</Td>
                  <Td mono>{r.registrations}</Td>
                  <Td mono>{r.bookings}</Td>
                  {/* Check-in, cancel and reschedule are one audit action, so
                      they cannot be split without recording the new status. */}
                  <Td mono>{r.updates}</Td>
                  <Td mono>{r.invoicesRaised}</Td>
                </>
              )}
            />

            <Section
              title="Billing — money taken and given back"
              empty="Nobody holds the billing role."
              rows={report.billing}
              head={['Person', 'Payments', 'Taken', 'Refunded', 'Kept', 'By method']}
              render={(b) => (
                <>
                  <Td>{b.fullName}</Td>
                  <Td mono>{b.count}</Td>
                  <Td mono>{fmt(b.total)}</Td>
                  {/* Attributed to whoever issued it. Shown separately rather
                      than folded into the total, so a day that took a lot and
                      gave a lot back is distinguishable from a quiet one. */}
                  <Td mono className={b.refunds > 0 ? 'text-danger' : 'text-text-subtle'}>
                    {b.refunds > 0 ? `−${fmt(b.refunded)}` : '—'}
                  </Td>
                  <Td mono className={b.count > 0 || b.refunds > 0 ? 'font-semibold' : ''}>
                    {fmt(b.net)}
                  </Td>
                  <Td className="text-xs text-text-muted">
                    {b.methods.length === 0
                      ? '—'
                      : b.methods.map((m) => `${titleise(m.method)} ${fmt(m.amount)}`).join(' · ')}
                  </Td>
                </>
              )}
            />

            <Section
              title="Pharmacy"
              empty="Nobody holds the pharmacy role."
              rows={report.pharmacy}
              head={['Person', 'Dispensed', 'Prepared', 'Stock received']}
              render={(p) => (
                <>
                  <Td>{p.fullName}</Td>
                  <Td mono>{p.dispensed}</Td>
                  <Td mono>{p.prepared}</Td>
                  <Td mono>{p.stockReceived}</Td>
                </>
              )}
            />

            <Section
              title="Nursing"
              empty="Nobody holds the nursing role."
              rows={report.nursing}
              head={['Person', 'Vitals recorded', 'Doses given', 'Bed moves']}
              render={(n) => (
                <>
                  <Td>{n.fullName}</Td>
                  <Td mono>{n.vitals}</Td>
                  <Td mono>{n.doses}</Td>
                  <Td mono>{n.admissions}</Td>
                </>
              )}
            />
          </div>
        )}
      </div>

      {ledger && (
        <LedgerPanel
          date={date}
          doctorId={ledger.doctorId}
          status={ledger.status}
          title={ledger.title}
          onClose={() => setLedger(null)}
        />
      )}
    </div>
  );
}

/* ────────────────────────── consultation ledger ────────────────────────── */

/**
 * A count, and a way to check it.
 *
 * Zero is not a link. There is nothing behind it, and a link that opens an
 * empty panel teaches people that the links do not work.
 */
function Count({ value, onClick }: { value: number; onClick: () => void }) {
  if (value === 0) return <span className="text-text-subtle">0</span>;
  return (
    <button onClick={onClick} className="font-semibold text-primary hover:underline">
      {value}
    </button>
  );
}

/**
 * The patients behind a number.
 *
 * WHAT IS HERE AND WHY IT IS ALLOWED
 * ----------------------------------
 * Name, time, whether they attended, what they were charged and whether they
 * paid. Every one of those is already on reception's screen at the desk and on
 * billing's invoice list — this is the same information, gathered by doctor and
 * day so an owner can reconcile their clinic.
 *
 * WHAT IS NOT HERE
 * ----------------
 * Why they came, what was found, what was prescribed. The appointment's own
 * `reason` field is typed by reception at booking and is routinely "chest
 * pain"; it sits one column away from everything above on the same record, and
 * the API deliberately does not fetch it.
 *
 * "Prescribed" is a tick, not a list. That a prescription was issued is a fact
 * about the consultation; what is in it names a condition, and an owner is not
 * automatically entitled to that about the people their doctors treat.
 */
function LedgerPanel({
  date,
  doctorId,
  status,
  title,
  onClose,
}: {
  date: string;
  doctorId?: number;
  status?: AppointmentStatus;
  title: string;
  onClose: () => void;
}) {
  const fmt = useMoney();
  const [data, setData] = useState<ConsultationLedger | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const qs = new URLSearchParams({ date });
    if (doctorId) qs.set('doctorId', String(doctorId));
    if (status) qs.set('status', status);
    api<ConsultationLedger>(`/admin/reports/consultations?${qs}`)
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load the list'));
  }, [date, doctorId, status]);

  return (
    <Sheet open onClose={onClose} title={title}>
      {error && <p className="text-sm text-danger">{error}</p>}
      {!data && !error && <Skeleton className="h-40" />}

      {data && (
        <>
          <p className="mb-3 text-xs text-text-subtle">
            {data.total} appointment{data.total === 1 ? '' : 's'} on {date}. Attendance and
            charges only — nothing clinical. For records or prescriptions, switch to a clinical
            role.
          </p>

          {data.total === 0 ? (
            <p className="py-6 text-center text-sm text-text-subtle">Nothing on this day.</p>
          ) : (
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr>
                  {['Time', 'Patient', 'Status', 'Charged', 'Paid', 'Rx'].map((h) => (
                    <th
                      key={h}
                      className="border-b border-border pb-1 text-left text-xxs font-semibold uppercase tracking-wider text-text-subtle"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.appointments.map((a) => (
                  <tr key={a.id}>
                    <Td mono>{dateTime(a.scheduledAt).slice(-5)}</Td>
                    <Td>
                      <div className="font-medium">{a.patient.fullName}</div>
                      <div className="text-xxs text-text-subtle">#{a.patient.id}</div>
                    </Td>
                    <Td>
                      <span
                        className={`rounded-full px-2 py-0.5 text-xxs font-semibold ${statusTone(
                          a.status,
                        )}`}
                      >
                        {titleise(a.status)}
                      </span>
                    </Td>
                    <Td mono muted={!a.invoice}>
                      {/* Not billed and billed zero are different facts, and
                          the dash says so. */}
                      {a.invoice ? fmt(a.invoice.total) : 'not billed'}
                    </Td>
                    <Td mono>
                      {!a.invoice ? (
                        <span className="text-text-subtle">—</span>
                      ) : a.invoice.settled ? (
                        <span className="text-success">paid</span>
                      ) : (
                        <span className="text-warning">{fmt(a.invoice.outstanding)} due</span>
                      )}
                    </Td>
                    <Td>
                      {a.prescriptionIssued ? (
                        <span className="text-text-muted" title="A prescription was issued">
                          ✓
                        </span>
                      ) : (
                        <span className="text-text-subtle">—</span>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </Sheet>
  );
}

function statusTone(status: AppointmentStatus): string {
  if (status === 'COMPLETED') return 'bg-success-soft text-success';
  if (status === 'NO_SHOW' || status === 'CANCELLED') return 'bg-danger-soft text-danger';
  return 'bg-[#eef0f2] text-text-muted';
}

/* ─────────────────────────────── pieces ─────────────────────────────── */

/**
 * One role's rows for the day.
 *
 * WHY THERE IS NO "FULL LOG" LINK
 * -------------------------------
 * Each row used to link into the audit browser filtered to that person and
 * day. It was removed: the audit trail is a list of API actions —
 * `PATIENT_CREATE`, `APPOINTMENT_STATUS_CHANGE`, `QUEUE_VIEW` — and an owner
 * reading it learns what the application called, not what their staff did.
 * Putting engineering vocabulary behind an ordinary-looking link makes the
 * screen feel like a debugging tool.
 *
 * The audit browser still exists under its own nav item for the compliance
 * question it answers, with the same `?userId=` and `?date=` filters. It is
 * simply not offered as the natural next click from a management screen.
 *
 * The drill-down that *is* offered is the consultation ledger: real patients,
 * real appointments, real money.
 */
function Section<T extends { userId: number; fullName: string }>({
  title,
  head,
  rows,
  render,
  empty,
}: {
  title: string;
  head: string[];
  rows: T[];
  render: (row: T) => React.ReactNode;
  empty: string;
}) {
  return (
    <Card>
      <h2 className="mb-2 text-md font-semibold">{title}</h2>
      {rows.length === 0 ? (
        <p className="py-3 text-sm text-text-subtle">{empty}</p>
      ) : (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr>
              {head.map((h) => (
                <th
                  key={h}
                  className="border-b border-border pb-1 text-left text-xxs font-semibold uppercase tracking-wider text-text-subtle"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.userId} className="hover:bg-[#fafbfc]">
                {render(row)}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function Td({
  children,
  mono,
  muted,
  className = '',
}: {
  children?: React.ReactNode;
  mono?: boolean;
  muted?: boolean;
  className?: string;
}) {
  return (
    <td
      className={`border-b border-[#f0f2f4] py-1.5 pr-3 ${mono ? 'font-mono text-xs' : ''} ${
        muted ? 'text-text-subtle' : ''
      } ${className}`}
    >
      {children}
    </td>
  );
}

/* ─────────────────────────────── dates ─────────────────────────────── */

/**
 * Today in the *hospital's* zone, not the browser's.
 *
 * A laptop that has travelled, or is simply set wrong, would otherwise open on
 * a day the clinic is not having. `en-CA` is the locale that formats as
 * YYYY-MM-DD, which is what the API expects.
 */
function todayIn(timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
}

/** Day arithmetic on the date string itself, so no timezone can shift it. */
function shift(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + days));
  return next.toISOString().slice(0, 10);
}

function titleise(value: string): string {
  return value
    .split('_')
    .map((w) => w.charAt(0) + w.slice(1).toLowerCase())
    .join(' ');
}
