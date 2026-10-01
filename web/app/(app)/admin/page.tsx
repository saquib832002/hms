'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { PeriodPicker, periodQuery, type Period } from '@/components/period-picker';
import {
  REVENUE_STREAM_LABEL,
  REVENUE_STREAM_MODULE,
  type DestinationBreakdown,
  type PatientActivity,
  type ReferralsOut,
  type ActivityReport,
  type AdminDashboard,
  type FinanceReport,
  type RevenueReport,
  type StaffReport,
  type StreamRevenue,
  type TenantModule,
} from '@/lib/types';
import { useAuth } from '@/lib/auth-context';
import { titleCase } from '@/lib/format';
import { Card, ErrorState, Skeleton, cx } from '@/components/ui/primitives';
import { Freshness } from '@/components/freshness';
import { useAutoRefresh } from '@/lib/use-auto-refresh';
import { useMoney } from '@/lib/use-money';

/**
 * Administrator dashboard.
 *
 * Aggregates only — no patient appears anywhere on this screen, and none can be
 * reached from it. A management dashboard is the obvious back door into clinical
 * data ("occupancy by diagnosis" sounds operational and is a list of who has
 * what), so the figures here are deliberately restricted to ones that carry no
 * clinical meaning.
 */
export default function AdminDashboardPage() {
  const fmt = useMoney();
  /*
   * ONE PERIOD, HELD HERE, DRIVING EVERY FETCH ON THE SCREEN.
   *
   * It used to live inside the revenue card, so the tiles above reported today
   * and the card below reported August with nothing saying so. Reported by the
   * product owner as exactly that: *"it should be showing data for all the
   * sections, even the top sections."*
   *
   * `null` is "this month", resolved on the server — the one case where the
   * browser's clock is never consulted at all.
   */
  const [period, setPeriod] = useState<Period | null>(null);
  const [dashboard, setDashboard] = useState<AdminDashboard | null>(null);
  const [revenue, setRevenue] = useState<RevenueReport | null>(null);
  const [activity, setActivity] = useState<ActivityReport | null>(null);
  const [staff, setStaff] = useState<StaffReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { user } = useAuth();
  /*
   * The dashboard is the floor — every tenant has one — but almost every tile
   * on it belonged to a module. A pharmacy-only tenant's owner opened this and
   * read appointments, bed occupancy and a doctor count, all zero, with nothing
   * about the shop they run. Zeroes for something you were never sold read as a
   * broken system rather than as a quiet default.
   */
  const has = (m: TenantModule) => user?.hospital.modules.includes(m) ?? true;
  const clinic = has('CLINIC');
  const wards = has('WARDS');
  const billing = has('BILLING');
  const pharmacy = has('PHARMACY');
  const laboratory = has('LABORATORY');

  const load = useCallback(async () => {
    setError(null);
    const query = periodQuery(period);
    try {
      /*
       * Both period-driven calls go out together with the *same* query string,
       * so the tiles and the stream table can never describe different spans.
       * `/reports/activity` is the audit-derived role breakdown and takes its
       * own `days`, which is a different question and deliberately untouched.
       */
      const [d, r, a, s] = await Promise.all([
        api<AdminDashboard>(`/admin/dashboard${query}`),
        api<RevenueReport>(`/admin/reports/revenue${query}`),
        api<ActivityReport>('/admin/reports/activity?days=7'),
        api<StaffReport>('/admin/reports/staff'),
      ]);
      setDashboard(d);
      setRevenue(r);
      setActivity(a);
      setStaff(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the dashboard');
    }
  }, [period]);

  const { lastUpdated, refreshing, refreshNow } = useAutoRefresh(load, { intervalMs: 60_000 });

  useEffect(() => {
    void refreshNow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period]);

  if (error && !dashboard) return <ErrorState message={error} onRetry={() => void refreshNow()} />;

  const over = dashboard?.overPeriod;
  const now = dashboard?.rightNow;
  const label = dashboard?.period.label ?? 'this period';

  return (
    <div className="scroll-thin flex-1 overflow-y-auto p-4">
      <div className="mb-3 flex items-start justify-between gap-4">
        <p className="text-sm text-text-muted">
          Operational figures only — no patient data is reachable from this screen.{' '}
          <Link href="/admin/reports" className="text-primary hover:underline">
            Full reports →
          </Link>
        </p>
        <Freshness
          lastUpdated={lastUpdated}
          refreshing={refreshing}
          onRefresh={() => void refreshNow()}
        />
      </div>

      {/* The one control. Everything under the period heading answers to it. */}
      <Card className="mb-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-md font-semibold">{label}</h2>
            <p className="text-xs text-text-subtle">
              Every figure under this heading covers {label}. Bed occupancy, staffing and
              queues are below, and ignore it.
            </p>
          </div>
          <div className="flex flex-col items-end gap-1.5">
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setPeriod(todayPeriod())}
                className="rounded px-2 py-1 text-xs text-text-muted hover:bg-bg"
              >
                Today
              </button>
              <input
                type="month"
                aria-label="Month"
                value={monthOf(dashboard?.period ?? null)}
                onChange={(e) => setPeriod(monthPeriod(e.target.value))}
                className="rounded border border-border bg-surface px-2 py-1 text-xs"
              />
            </div>
            <PeriodPicker
              value={period}
              onChange={setPeriod}
              label={dashboard?.period.label}
              busy={refreshing}
            />
          </div>
        </div>
      </Card>

      {!dashboard || !over || !now ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <>
          <div className="grid grid-cols-4 gap-3">
            {clinic && (
              <Metric
                label="Appointments"
                value={over.activity.appointments}
                sub={`${over.activity.attended} attended · ${over.activity.noShows} no-show`}
              />
            )}
            {clinic && (
              <Metric
                label="Patients seen"
                value={over.activity.patientsSeen}
                sub={`${over.activity.registered} newly registered`}
              />
            )}
            {billing && (
              <Metric
                label="Collected"
                value={fmt(over.finance.collected)}
                sub={`${fmt(over.finance.billed)} billed · ${fmt(over.finance.net)} net of refunds`}
                tone="success"
                mono
              />
            )}
            {pharmacy && (
              <Metric
                label="Dispensed"
                value={over.pharmacy.dispenses}
                tone={over.pharmacy.unpricedSales > 0 ? 'warning' : undefined}
                sub={
                  over.pharmacy.unpricedSales > 0
                    ? `${over.pharmacy.unpricedSales} went out unpriced`
                    : `${over.pharmacy.reversals} reversed`
                }
              />
            )}
            {laboratory && (
              <Metric label="Tests ordered" value={over.laboratory.ordersPlaced} />
            )}
            {clinic && (
              <Metric
                label="No-show rate"
                value={`${over.activity.noShowRate}%`}
                sub={`${over.activity.noShows} of ${over.activity.appointments}`}
                tone={over.activity.noShowRate > 15 ? 'warning' : undefined}
              />
            )}
          </div>

          {clinic && <DoctorActivity activity={over.activity} fmt={fmt} label={label} />}

          {billing && <RevenueStreams report={revenue} has={has} fmt={fmt} />}

          <ReferralsOutCard
            out={over.referralsOut}
            fmt={fmt}
            pharmacy={pharmacy}
            laboratory={laboratory}
            label={label}
          />

          {/*
            RIGHT NOW. Its own heading, and the heading says the period does not
            apply — because a figure that silently ignores the dates above it,
            sitting among figures that do not, is the fault this split exists
            for.
          */}
          <h2 className="mt-5 text-md font-semibold">
            Right now{' '}
            <span className="text-xs font-normal text-text-subtle">
              — as things stand today, whatever period is selected above
            </span>
          </h2>
          <div className="mt-2 grid grid-cols-4 gap-3">
            {billing && (
              <Metric
                label="Owed, all time"
                value={fmt(now.finance.outstanding)}
                sub={`${now.finance.openInvoices} open invoices`}
                tone={now.finance.outstanding !== '0.00' ? 'warning' : undefined}
                mono
              />
            )}
            {wards && (
              <Metric
                label="Bed occupancy"
                value={`${now.occupancy.percent}%`}
                sub={`${now.occupancy.occupied} of ${now.occupancy.beds} · ${now.occupancy.available} free`}
              />
            )}
            {clinic && (
              <Metric
                label="Doctors"
                value={now.staff.doctors}
                tone={now.staff.doctorsWithoutFee > 0 ? 'warning' : undefined}
                sub={
                  now.staff.doctorsWithoutFee > 0
                    ? `${now.staff.doctorsWithoutFee} with no fee set`
                    : 'all priced'
                }
              />
            )}
            {laboratory && (
              <Metric
                label="To authorise"
                value={now.laboratory.awaitingAuthorisation}
                sub={`${now.laboratory.awaitingCollection} to collect · ${now.laboratory.onTheBench} on the bench`}
                tone={now.laboratory.awaitingAuthorisation > 0 ? 'warning' : undefined}
              />
            )}
            <Metric
              label="Active staff"
              value={now.staff.active}
              sub={`${now.staff.awaitingPasswordChange} must change password`}
            />
            <Metric
              label="Locked out"
              value={now.staff.lockedOut}
              tone={now.staff.lockedOut > 0 ? 'warning' : undefined}
            />
            <Metric
              label="Denied requests, 24h"
              value={now.security.deniedRequestsLastDay}
              tone={now.security.deniedRequestsLastDay > 20 ? 'warning' : undefined}
            />
            {pharmacy && (
              <Metric
                label="Medicines"
                value={now.catalogue.medicines}
                tone={now.catalogue.withoutPrice > 0 ? 'warning' : undefined}
                sub={
                  now.catalogue.withoutPrice > 0
                    ? `${now.catalogue.withoutPrice} with no price`
                    : 'all priced'
                }
              />
            )}
          </div>

          <div className="mt-4 grid grid-cols-2 gap-3">
            <Card>
              <div className="mb-2 flex items-baseline justify-between">
                <h2 className="text-md font-semibold">Activity by role, 7 days</h2>
                <Link href="/audit" className="text-xs text-primary hover:underline">
                  Audit log →
                </Link>
              </div>
              {!activity ? (
                <Skeleton className="h-32" />
              ) : (
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="text-xxs uppercase tracking-wider text-text-muted">
                      <th className="py-1 text-left font-medium">Role</th>
                      <th className="py-1 text-right font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activity.byRole.map((row) => (
                      <tr key={row.role} className="border-t border-border">
                        <td className="py-1.5">{titleCase(row.role)}</td>
                        <td className="py-1.5 text-right font-mono">{row.total}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>

            <Card>
              <div className="mb-2 flex items-baseline justify-between">
                <h2 className="text-md font-semibold">Staff</h2>
                <Link href="/admin/users" className="text-xs text-primary hover:underline">
                  Manage →
                </Link>
              </div>
              {!staff ? (
                <Skeleton className="h-32" />
              ) : (
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="text-xxs uppercase tracking-wider text-text-muted">
                      <th className="py-1 text-left font-medium">Role</th>
                      <th className="py-1 text-right font-medium">Active</th>
                    </tr>
                  </thead>
                  <tbody>
                    {staff.roles.map((row) => (
                      <tr key={row.role} className="border-t border-border">
                        <td className="py-1.5">{titleCase(row.role)}</td>
                        <td className="py-1.5 text-right font-mono">{row.active}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * A row per doctor: patients seen, consultations, and what it came to.
 *
 * Asked for by the product owner — *"how many patients a doctor has seen and
 * how much total collection from those patients."*
 *
 * **The counts link into the consultation ledger, which is where names live.**
 * That endpoint returns the patients behind a count and carries
 * `ADMIN_CONSULTATION_LEDGER` as its own audit action, precisely so "who looked
 * up our patient list, and when" stays answerable without unpicking a generic
 * report action. Nothing on this card is a name.
 *
 * Zero is deliberately not a link: a link that opens an empty panel teaches
 * people the links do not work.
 */
function DoctorActivity({
  activity,
  fmt,
  label,
}: {
  activity: PatientActivity;
  fmt: (a: string) => string;
  label: string;
}) {
  if (activity.byDoctor.length === 0) return null;
  return (
    <Card className="mt-4">
      <div className="mb-2 flex items-baseline justify-between">
        <div>
          <h2 className="text-md font-semibold">Who saw whom</h2>
          <p className="text-xs text-text-subtle">
            {activity.patientsSeen} distinct patients across the hospital in {label} — not the
            sum of the rows, since one patient may see two doctors.
          </p>
        </div>
        <Link href="/admin/reports" className="text-xs text-primary hover:underline">
          Daily activity →
        </Link>
      </div>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="text-xxs uppercase tracking-wider text-text-muted">
            <th className="py-1 text-left font-medium">Doctor</th>
            <th className="py-1 text-right font-medium">Patients seen</th>
            <th className="py-1 text-right font-medium">Consultations</th>
            <th className="py-1 text-right font-medium">No-shows</th>
            <th className="py-1 text-right font-medium">Billed</th>
            <th className="py-1 text-right font-medium">Collected</th>
          </tr>
        </thead>
        <tbody>
          {activity.byDoctor.map((row) => (
            <tr key={row.doctorId} className="border-t border-border">
              <td className="py-1.5">{row.name}</td>
              <td className="py-1.5 text-right font-mono">
                {row.patientsSeen === 0 ? (
                  '—'
                ) : (
                  <Link
                    href={`/admin/reports?doctorId=${row.doctorId}`}
                    className="text-primary hover:underline"
                  >
                    {row.patientsSeen}
                  </Link>
                )}
              </td>
              <td className="py-1.5 text-right font-mono">{row.consultations}</td>
              <td className="py-1.5 text-right font-mono text-text-subtle">
                {row.noShows === 0 ? '—' : row.noShows}
              </td>
              <td className="py-1.5 text-right font-mono">{fmt(row.billed)}</td>
              <td
                className={cx(
                  'py-1.5 text-right font-mono',
                  row.collected !== row.billed ? 'text-warning' : 'text-success',
                )}
              >
                {fmt(row.collected)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-xs text-text-subtle">
        Billed and collected sit side by side because payment is never required before a
        consultation — the gap between them is real, and reporting only what was charged is how
        a clinic mistakes invoices raised for money in the bank.
      </p>
    </Card>
  );
}

/**
 * Where prescriptions and test requests went.
 *
 * Asked for by the product owner — *"if a doctor prescribes to an outside
 * pharmacy, we should track those separately from our clinic. What different
 * pharmacies outside my hospital has that prescription gone to. Same for the
 * tests."*
 *
 * Counts and partner names only, never a drug or a test name. A test name is
 * frequently the clinical question itself, and this card is read by whoever
 * reconciles bills — the same rule `labSummaryDescription` already follows.
 */
function ReferralsOutCard({
  out,
  fmt,
  pharmacy,
  laboratory,
  label,
}: {
  out: ReferralsOut;
  fmt: (a: string) => string;
  pharmacy: boolean;
  laboratory: boolean;
  label: string;
}) {
  const nothingLeft =
    out.prescriptions.external + out.prescriptions.partner + out.labOrders.external +
      out.labOrders.partner ===
    0;
  // A clinic that fills everything itself has nothing to track, and an empty
  // card is furniture.
  if (nothingLeft) return null;

  return (
    <Card className="mt-4">
      <h2 className="text-md font-semibold">What left the hospital</h2>
      <p className="mb-2 text-xs text-text-subtle">
        Prescriptions and tests sent elsewhere in {label}. Counts and partners only — never
        which medicine or which test.
      </p>

      <div className="grid grid-cols-2 gap-4">
        {pharmacy && <Destinations title="Prescriptions" b={out.prescriptions} />}
        {laboratory && <Destinations title="Test requests" b={out.labOrders} />}
      </div>

      {out.owedToPartners.length > 0 && (
        <div className="mt-3 border-t border-border pt-2">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-text-muted">
            What the partner labs charged us
          </h3>
          <table className="mt-1 w-full border-collapse text-sm">
            <tbody>
              {out.owedToPartners.map((p) => (
                <tr key={p.tenantId} className="border-t border-border">
                  <td className="py-1.5">{p.label}</td>
                  <td className="py-1.5 text-right font-mono">{fmt(p.charged)}</td>
                  <td className="py-1.5 text-right font-mono">
                    {p.unsettled === '0.00' ? (
                      <span className="text-text-subtle">settled</span>
                    ) : (
                      <span className="text-warning">{fmt(p.unsettled)} unsettled</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-1 text-xs text-text-subtle">
            A notice rather than a creditor ledger: settling with another company is a bank
            transfer and a telephone call, and marking one settled records no payment.
          </p>
        </div>
      )}

      <div className="mt-3 border-t border-border pt-2 text-sm">
        <span className="font-mono">{fmt(out.referredBilling.charged)}</span>{' '}
        <span className="text-text-subtle">billed to patients for referred work</span>
        {out.referredBilling.payableElsewhere > 0 && (
          <>
            {' · '}
            <span className="text-text-subtle">
              {out.referredBilling.payableElsewhere} the patient pays the lab directly
            </span>
          </>
        )}
        {/*
          Kept apart from the line above it, deliberately. Under PATIENT_PAYS no
          line is raised on purpose; an unpriced one is a real loss. Merging them
          would make every "went out uncharged" figure report the first forever,
          and people stop reading the figure that catches the second.
        */}
        {out.referredBilling.unpriced > 0 && (
          <>
            {' · '}
            <span className="text-warning">
              {out.referredBilling.unpriced} ours to charge and unpriced
            </span>
          </>
        )}
      </div>
    </Card>
  );
}

/** In-house, each named partner, and what simply walked out of the building. */
function Destinations({ title, b }: { title: string; b: DestinationBreakdown }) {
  return (
    <div>
      <h3 className="text-xs font-semibold uppercase tracking-wider text-text-muted">
        {title} · {b.total}
      </h3>
      <table className="mt-1 w-full border-collapse text-sm">
        <tbody>
          <tr className="border-t border-border">
            <td className="py-1">Filled here</td>
            <td className="py-1 text-right font-mono">{b.inHouse}</td>
          </tr>
          {b.partners.map((p) => (
            <tr key={p.tenantId} className="border-t border-border">
              <td className="py-1">{p.label}</td>
              <td className="py-1 text-right font-mono">{p.count}</td>
            </tr>
          ))}
          <tr className="border-t border-border">
            {/*
              Its own row rather than an unnamed partner: the patient took it
              away to fill wherever they chose, there is nobody to name, and a
              row reading "Partner: (unknown)" sends somebody looking for a
              partnership that was never meant to exist.
            */}
            <td className="py-1">
              Taken elsewhere
              <span className="ml-1 text-xxs text-text-subtle">patient&rsquo;s choice</span>
            </td>
            <td className="py-1 text-right font-mono">{b.external}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function RevenueStreams({
  report,
  has,
  fmt,
}: {
  report: RevenueReport | null;
  has: (m: TenantModule) => boolean;
  fmt: (amount: string) => string;
}) {
  /*
   * No period of its own and no fetch of its own. The page holds one period and
   * hands the resolved report down — two controls on one screen would be two
   * answers to "which dates", and the reader would believe whichever they
   * looked at first.
   */

  /*
   * A stream is shown when the hospital holds its module. `HOSPITAL` maps to no
   * module, so a tenant stripped back to the floor still sees its own takings.
   *
   * The `ALL` row is kept whatever is visible, and it is deliberately the
   * server's own total over every stream rather than a sum of the rows on
   * screen: a hospital that has handed back the laboratory still has lab
   * invoices in its history, and a total that quietly excluded them would
   * disagree with the bank.
   */
  const visible = (report?.streams ?? []).filter((r) => {
    if (r.stream === 'ALL') return true;
    const module = REVENUE_STREAM_MODULE[r.stream];
    return module === null || has(module);
  });

  return (
    <Card className="mt-4">
      <div className="mb-2">
        <h2 className="text-md font-semibold">Where the money came from</h2>
        <p className="text-xs text-text-subtle">
          Each business on its own books, and the combined total, over{' '}
          {report?.period.label ?? 'the period'}.
        </p>
      </div>

      {!report ? (
        <Skeleton className="h-32" />
      ) : visible.length < 3 ? (
        /*
         * One stream and the identical total beside it is a table that says the
         * same thing twice. A clinic with no pharmacy and no lab reads the tiles
         * above; the period control is at the top of the screen and drives
         * these figures either way.
         */
        <SingleStream row={visible[0] ?? null} fmt={fmt} />
      ) : (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="text-xxs uppercase tracking-wider text-text-muted">
              <th className="py-1 text-left font-medium">Stream</th>
              <th className="py-1 text-right font-medium">Billed</th>
              <th className="py-1 text-right font-medium">Collected</th>
              <th className="py-1 text-right font-medium">Back</th>
              <th className="py-1 text-right font-medium">Net</th>
              <th className="py-1 text-right font-medium">Tax</th>
              <th className="py-1 text-right font-medium">Unpaid, period</th>
              <th className="py-1 text-right font-medium">Owed, all time</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => {
              const f = row.period;
              const total = row.stream === 'ALL';
              return (
                <tr
                  key={row.stream}
                  className={cx(
                    'border-t border-border',
                    total && 'border-t-2 border-border-strong font-semibold',
                  )}
                >
                  <td className="py-1.5">
                    {REVENUE_STREAM_LABEL[row.stream]}
                    {/*
                     * An unsettled counter sale is an unreconciled till, not a
                     * debtor — it is deliberately absent from the 30/60/90
                     * aging buckets. Saying so here is the difference between a
                     * figure somebody reconciles and a figure somebody chases a
                     * walk-in over.
                     */}
                    {!row.chaseable && row.stream === 'PHARMACY' && (
                      <span className="ml-1.5 text-xxs font-normal text-text-subtle">
                        counter sales
                      </span>
                    )}
                  </td>
                  <td className="py-1.5 text-right font-mono">{fmt(f.billed)}</td>
                  <td className="py-1.5 text-right font-mono">{fmt(f.collected)}</td>
                  {/* Zero refunds is the common case and a column of 0.00 is
                      noise that makes the figures that moved harder to find. */}
                  <td className="py-1.5 text-right font-mono text-text-subtle">
                    {f.refunded === '0.00' ? '—' : fmt(f.refunded)}
                  </td>
                  <td
                    className={cx(
                      'py-1.5 text-right font-mono',
                      Number(f.net) < 0 ? 'text-danger' : 'text-success',
                    )}
                  >
                    {fmt(f.net)}
                  </td>
                  <td className="py-1.5 text-right font-mono text-text-subtle">
                    {f.tax === '0.00' ? '—' : fmt(f.tax)}
                  </td>
                  <td className="py-1.5 text-right font-mono">
                    {row.outstandingInPeriod === '0.00' ? (
                      '—'
                    ) : (
                      <span className={row.chaseable ? 'text-warning' : undefined}>
                        {fmt(row.outstandingInPeriod)}
                      </span>
                    )}
                  </td>
                  {/* All-time, and in its own column saying so. It was folded
                      into the period row, where it showed a months-old balance
                      next to today's figures with nothing explaining why. */}
                  <td className="py-1.5 text-right font-mono text-text-subtle">
                    {row.outstandingAllTime === '0.00' ? '—' : fmt(row.outstandingAllTime)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <p className="mt-2 text-xs text-text-subtle">
        Billed is what was charged in {report?.period.label ?? 'the period'}; collected is what
        arrived, which is a different question — payment is never required before care.{' '}
        <strong>Unpaid, period</strong> is how much of that period&rsquo;s billing has not been
        settled. <strong>Owed, all time</strong> ignores the period entirely, because last
        month&rsquo;s unpaid invoice is still money owed today.
      </p>
    </Card>
  );
}

/** A tenant with one stream reads a list, not a table with a redundant total. */
function SingleStream({ row, fmt }: { row: StreamRevenue | null; fmt: (a: string) => string }) {
  if (!row) return <p className="py-4 text-sm text-text-subtle">Nothing billed in this period.</p>;
  const pairs: [string, string][] = [
    ['Billed', fmt(row.period.billed)],
    ['Collected', fmt(row.period.collected)],
    ['Refunded', fmt(row.period.refunded)],
    ['Net', fmt(row.period.net)],
    ['Tax', fmt(row.period.tax)],
    ['Unpaid, period', fmt(row.outstandingInPeriod)],
    ['Owed, all time', fmt(row.outstandingAllTime)],
  ];
  return (
    <dl className="grid grid-cols-4 gap-2">
      {pairs.map(([k, v]) => (
        <div key={k}>
          <dt className="text-xxs uppercase tracking-wider text-text-muted">{k}</dt>
          <dd className="font-mono text-sm">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** `2026-09-01` for a `Date`, in the browser's own calendar. */
function dateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

/**
 * Today as a one-day period.
 *
 * This does consult the device's clock, like the picker's own rolling presets —
 * and the server echoes back what it resolved, which is printed, so a browser a
 * day out from its hospital shows a correctable difference rather than a silent
 * one.
 */
function todayPeriod(): Period {
  const now = new Date();
  return { from: dateKey(now), to: dateKey(now) };
}

/**
 * A `YYYY-MM` from the month input, as that calendar month's first and last day.
 *
 * Arithmetic on the chosen year and month, never on "now" — `new Date(y, m, 0)`
 * is the last day of month `m`, which handles February and leap years without a
 * table. The server then recognises the range as a whole month and labels it as
 * one.
 */
function monthPeriod(value: string): Period | null {
  const m = /^(\d{4})-(\d{2})$/.exec(value);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return {
    from: `${m[1]}-${m[2]}-01`,
    to: dateKey(new Date(year, month, 0)),
  };
}

/** The month input's value, taken from what the *server* resolved. */
function monthOf(period: { from: string; wholeMonth: boolean } | null): string {
  if (!period?.wholeMonth) return '';
  return period.from.slice(0, 7);
}

function Metric({
  label,
  value,
  sub,
  tone,
  mono,
}: {
  label: string;
  value: string | number;
  sub?: string;
  tone?: 'success' | 'warning' | 'danger';
  mono?: boolean;
}) {
  const colour =
    tone === 'success'
      ? 'text-success'
      : tone === 'warning'
        ? 'text-warning'
        : tone === 'danger'
          ? 'text-danger'
          : 'text-text';
  return (
    <Card>
      <div className={`text-2xl font-bold tracking-tight ${colour} ${mono ? 'font-mono' : ''}`}>
        {value}
      </div>
      <div className="text-xxs uppercase tracking-wider text-text-muted">{label}</div>
      {sub && <div className="mt-0.5 text-xs text-text-subtle">{sub}</div>}
    </Card>
  );
}
