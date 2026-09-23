'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { openDocument } from '@/lib/documents';
import { api, ApiError } from '@/lib/api';
import { useUser } from '@/lib/auth-context';
import type {
  LabOrder,
  MedicalRecord,
  Paginated,
  Patient,
  PatientListItem,
  Prescription,
  RoutingTrail,
  TenantModule,
} from '@/lib/types';
import { date, dateTime, titleCase } from '@/lib/format';
import { routingLine } from '@/lib/routing-line';
import { Card, EmptyState, ErrorState, Input, Skeleton } from '@/components/ui/primitives';
import { AllergyBanner } from '@/components/allergy-banner';
import { Button } from '@/components/ui/primitives';
import { PatientEditSheet } from '@/components/patient-edit-sheet';
import { PrescriptionSheet } from '@/components/prescription-sheet';
import { LabOrderSheet } from '@/components/lab-order-sheet';
import { LabAttachments } from '@/components/lab-attachments';
import { LabAuthorisationNotice, LabItemPanel } from '@/components/lab-result-table';
import { RecordSheet } from '@/components/record-sheet';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';

export default function PatientsPage() {
  return (
    <Suspense fallback={<div className="p-4 text-sm text-text-subtle">Loading…</div>}>
      <PatientsView />
    </Suspense>
  );
}

/**
 * Two-pane: list left, detail right. Selecting a patient updates the URL
 * (?id=12) so views stay linkable and the back button behaves — but never
 * reloads the page.
 *
 * The detail pane renders whatever the API chose to send. For a receptionist
 * that response contains no clinical fields at all, so the clinical sections
 * simply do not appear. The UI is not hiding them; they were never sent.
 */
function PatientsView() {
  const user = useUser();
  const router = useRouter();
  const params = useSearchParams();
  const selectedId = params.get('id') ? Number(params.get('id')) : null;

  const [query, setQuery] = useState('');
  const [list, setList] = useState<PatientListItem[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  const loadList = useCallback(async (q: string) => {
    setListError(null);
    try {
      const res = await api<Paginated<PatientListItem>>(
        `/patients?limit=50${q ? `&q=${encodeURIComponent(q)}` : ''}`,
      );
      setList(res.data);
    } catch (err) {
      setListError(err instanceof Error ? err.message : 'Could not load patients');
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void loadList(query.trim()), query ? 250 : 0);
    return () => clearTimeout(t);
  }, [query, loadList]);

  const select = (id: number) => router.replace(`/patients?id=${id}`, { scroll: false });

  return (
    <div className="flex min-h-0 flex-1">
      <div className="scroll-thin flex w-[300px] shrink-0 flex-col border-r border-border bg-surface">
        <div className="border-b border-border p-2">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter patients…"
            className="text-sm"
          />
        </div>
        <div className="flex-1 overflow-y-auto">
          {!list && !listError && (
            <div className="space-y-2 p-3">
              {Array.from({ length: 10 }).map((_, i) => (
                <Skeleton key={i} className="h-4" />
              ))}
            </div>
          )}
          {listError && <ErrorState message={listError} onRetry={() => void loadList(query)} />}
          {list?.length === 0 && <EmptyState title="No patients found" />}
          {list?.map((p) => (
            <button
              key={p.id}
              onClick={() => select(p.id)}
              className={`flex w-full items-center gap-2 border-b border-[#f0f2f4] px-3 py-2 text-left text-sm ${
                p.id === selectedId ? 'bg-primary-soft shadow-[inset_2px_0_0_#1e6fd9]' : 'hover:bg-[#fafbfc]'
              }`}
            >
              <span className="flex-1 truncate font-medium">{p.fullName}</span>
              {p.hasAllergies && (
                <span title="Has recorded allergies" className="h-1.5 w-1.5 rounded-full bg-danger" />
              )}
              <span className="font-mono text-xs text-text-subtle">#{p.id}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="scroll-thin flex-1 overflow-y-auto p-4">
        {selectedId ? (
          <PatientDetail
            id={selectedId}
            canSeeClinical={['DOCTOR', 'NURSE'].includes(user.role)}
            modules={user.hospital.modules}
            canEdit={['ADMIN', 'RECEPTIONIST'].includes(user.role)}
            onRenamed={() => void loadList(query.trim())}
          />
        ) : (
          <EmptyState
            title="Select a patient"
            description="Choose someone from the list, or press ⌘K to search."
          />
        )}
      </div>
    </div>
  );
}

function PatientDetail({
  id,
  canSeeClinical,
  modules,
  canEdit,
  onRenamed,
}: {
  id: number;
  canSeeClinical: boolean;
  /**
   * The patient record is always-on — every tenant has somebody to serve — but
   * three of its four tabs are not. Records and prescriptions are the clinic;
   * investigations are the laboratory. A pharmacy-only tenant opening a patient
   * would otherwise get tabs whose endpoints refuse.
   *
   * This screen cannot simply carry a module tag like the others, because the
   * thing that varies is a tab rather than the page.
   */
  modules: TenantModule[];
  canEdit: boolean;
  onRenamed: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [patient, setPatient] = useState<Patient | null>(null);
  const [records, setRecords] = useState<MedicalRecord[] | null>(null);
  const [prescriptions, setPrescriptions] = useState<Prescription[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'overview' | 'records' | 'prescriptions' | 'tests'>('overview');
  const hasClinic = modules.includes('CLINIC');
  const hasLab = modules.includes('LABORATORY');
  /** The prescription being withdrawn, held while the reason is confirmed. */
  const [cancelling, setCancelling] = useState<Prescription | null>(null);
  /** Items carried into a fresh prescription after one is cancelled. */
  const [rewriteFrom, setRewriteFrom] = useState<Prescription | null>(null);
  /*
   * A prescription written from the record rather than from a cancellation.
   * Separate state because `rewriteFrom` carries the lines to pre-fill, and a
   * new one starts empty — reusing it would have meant a sentinel value that
   * means "open, but with nothing in it".
   */
  const [writingNew, setWritingNew] = useState(false);
  const [requestingTests, setRequestingTests] = useState(false);
  const [labOrders, setLabOrders] = useState<LabOrder[] | null>(null);
  const [writingRecordFor, setWritingRecordFor] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  const user = useUser();
  /*
   * Only the issuing doctor may withdraw, and the server checks it regardless.
   * This just avoids offering a button whose only outcome is a 403.
   */
  const canPrescribe = user.role === 'DOCTOR';

  async function cancelPrescription(p: Prescription) {
    setCancelError(null);
    try {
      await api(`/prescriptions/${p.id}/cancel`, { method: 'PATCH' });
      const refreshed = await api<{ data: Prescription[] }>(`/patients/${id}/prescriptions`);
      setPrescriptions(refreshed.data);
      setCancelling(null);
      /*
       * Straight into a new prescription, pre-filled with what was cancelled.
       *
       * The doctor's actual intent is almost always "that was nearly right" —
       * a wrong dose, a wrong duration. Making them retype four correct lines
       * to fix one is how a correction gets skipped, and a wrong prescription
       * left standing because fixing it was tedious is the failure that
       * matters here.
       */
      setRewriteFrom(p);
    } catch (err) {
      // "already dispensed", "not yours", "already cancelled" all arrive here
      // with the server's own wording.
      setCancelError(err instanceof ApiError ? err.message : 'Could not cancel that prescription');
      setCancelling(null);
    }
  }

  useEffect(() => {
    setPatient(null);
    setRecords(null);
    setPrescriptions(null);
    setError(null);
    setTab('overview');

    api<Patient>(`/patients/${id}`)
      .then(setPatient)
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load this patient'));

    // Clinical relations live behind their own role-guarded endpoints. Roles
    // without access simply never make these calls.
    if (canSeeClinical && hasClinic) {
      api<{ data: MedicalRecord[] }>(`/patients/${id}/records`)
        .then((r) => setRecords(r.data))
        .catch(() => setRecords([]));
      api<{ data: Prescription[] }>(`/patients/${id}/prescriptions`)
        .then((r) => setPrescriptions(r.data))
        .catch(() => setPrescriptions([]));
    }
    if (canSeeClinical && hasLab) {
      api<{ data: LabOrder[] }>(`/patients/${id}/lab-orders`)
        .then((r) => setLabOrders(r.data))
        .catch(() => setLabOrders([]));
    }
  }, [id, canSeeClinical, hasClinic, hasLab]);

  if (error) return <ErrorState message={error} />;
  if (!patient) return <Skeleton className="h-48 w-full" />;

  return (
    <>
      <Card>
        <div className="text-lg font-bold tracking-tight">{patient.fullName}</div>
        <div className="font-mono text-xs text-text-muted">
          {patient.age}y · {patient.gender.toLowerCase()}
          {patient.bloodGroup ? ` · ${patient.bloodGroup}` : ''} · #{patient.id}
        </div>

        <div className="mt-2.5">
          <AllergyBanner allergies={patient.allergies} />
        </div>

        <div className="mt-3 flex gap-0.5 border-b border-border">
          {(
            [
              ['overview', 'Overview'],
              ...(canSeeClinical && hasClinic
                ? ([
                    ['records', 'Records'],
                    ['prescriptions', 'Prescriptions'],
                    /*
                     * Investigations belong beside the other two, not behind a
                     * separate screen.
                     *
                     * "Request tests" was on this page from the day the lab
                     * shipped and there was nowhere to see what came back —
                     * the results lived on `/lab/results`, which means a
                     * doctor with the patient already open had to search for
                     * them again by name. Ordering somewhere you cannot read
                     * the answer is half a feature.
                     */
                  ] as const)
                : []),
              ...(canSeeClinical && hasLab ? ([['tests', 'Tests']] as const) : []),
            ] as [typeof tab, string][]
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`border-b-2 px-3 py-1.5 text-sm ${
                tab === key
                  ? 'border-b-primary font-semibold text-primary'
                  : 'border-b-transparent text-text-muted hover:text-text'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/*
          The clinical actions live here, above the tabs, and not inside them.
          -------------------------------------------------------------------
          They were put inside the Prescriptions and Records tabs first, which
          was wrong for a reason worth keeping: a doctor opening a patient
          lands on Overview, and an action they cannot see is an action that
          does not exist. Reported as missing within minutes of shipping.

          Mobile already had this right — "Write prescription" is a standing
          button on the patient screen, not something behind a tab.

          Nothing here is a security boundary. The server decides whether this
          doctor may write for this patient (`treating-scope.ts`); this only
          avoids offering a button whose sole outcome would be a 403.
        */}
        {(canPrescribe || canEdit) && (
          <div className="mt-3 flex flex-wrap gap-2">
            {canPrescribe && (
              <>
                <Button size="sm" variant="primary" onClick={() => setWritingNew(true)}>
                  New prescription
                </Button>
                <Button size="sm" onClick={() => setWritingRecordFor(true)}>
                  Add a record
                </Button>
                {/* Investigations sit beside prescribing rather than behind a
                    tab, for the reason the prescription button moved here:
                    the API has permitted this since the module shipped, and a
                    capability with no entry point is a capability nobody has.
                    The results come back on the Lab Results screen and on the
                    patient's file. */}
                <Button size="sm" onClick={() => setRequestingTests(true)}>
                  Request tests
                </Button>
              </>
            )}
            {canEdit && (
              <Button size="sm" onClick={() => setEditing(true)}>
                Edit details
              </Button>
            )}
          </div>
        )}

        {canPrescribe && (
          <p className="mt-1.5 text-xs text-text-subtle">
            For a patient you have seen in the last 90 days or who is admitted here. A
            prescription written outside a visit is not attached to one, so nothing is billed for
            it.
          </p>
        )}

        {/*
          Why the clinical actions are absent, said out loud.
          --------------------------------------------------
          Writing is gated on the role being *acted as*, not the roles held —
          an owner-doctor signed in as ADMIN holds DOCTOR and still cannot
          prescribe, which is the whole point of wearing one role at a time.

          Silence here is indistinguishable from a broken button, and cost
          three rounds of "I still don't see it" to diagnose. If someone can
          switch into a role that would let them write, the page says so and
          names the switcher, rather than leaving them looking for a setting
          that does not exist.
        */}
        {!canPrescribe && (
          <p className="mt-1.5 text-xs text-text-subtle">
            Acting as <strong>{user.role.toLowerCase().replace('_', ' ')}</strong> — only a doctor
            can write prescriptions and records.
            {user.availableRoles.includes('DOCTOR')
              ? ' Switch to Doctor in the role menu.'
              : ' This account does not hold the Doctor role.'}
          </p>
        )}

        {tab === 'overview' && (
          <dl className="mt-3 grid grid-cols-[110px_1fr] gap-x-3 gap-y-1.5 text-sm">
            <Row label="Date of birth" value={date(patient.dob)} mono />
            <Row label="Phone" value={patient.phone ?? '—'} mono />
            <Row label="Email" value={patient.email ?? '—'} mono />
            <Row label="Address" value={patient.address ?? '—'} />
            <Row
              label="Emergency"
              value={
                patient.emergencyContactName
                  ? `${patient.emergencyContactName} · ${patient.emergencyContactPhone ?? ''}`
                  : '—'
              }
            />
            <Row label="Registered" value={date(patient.createdAt)} mono />
          </dl>
        )}

        {tab === 'records' && (
          <div className="mt-3">
            {!records && <Skeleton className="h-20" />}
            {records?.length === 0 && (
              <p className="py-6 text-center text-sm text-text-subtle">No records yet</p>
            )}
            <div className="space-y-2.5">
              {records?.map((r) => (
                <div key={r.id} className="border-l-2 border-border pl-3">
                  <div className="text-sm font-semibold">
                    {date(r.visitDate)} — {r.diagnosis}
                  </div>
                  <div className="text-sm text-text-muted">{r.notes ?? 'No notes'}</div>
                  <div className="flex items-baseline gap-2 text-xs text-text-subtle">
                    <span>{r.doctor?.fullName ?? 'Unknown'}</span>
                    {/*
                      A button, not an anchor. The access token lives in memory
                      and travels as a header — a plain link to /api/v1 sends
                      none and comes back 401, which is what the old print link
                      did silently from Phase 1 onwards.
                    */}
                    <button
                      onClick={() => void openDocument('records', r.id)}
                      className="text-primary hover:underline"
                    >
                      Print
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === 'tests' && (
          <div className="mt-3">
            {!labOrders && <Skeleton className="h-20" />}
            {labOrders?.length === 0 && (
              <p className="py-6 text-center text-sm text-text-subtle">
                No investigations requested for this patient.
              </p>
            )}
            <div className="space-y-2.5">
              {(labOrders ?? []).map((o) => (
                <div key={o.id} className="rounded-md border border-border bg-surface p-3">
                  <div className="mb-2 flex flex-wrap items-baseline gap-2">
                    <span className="font-mono text-xs text-text-muted">#{o.id}</span>
                    <span className="text-sm font-medium">{titleCase(o.status)}</span>
                    {o.priority !== 'ROUTINE' && (
                      <span className="text-xxs uppercase text-text-subtle">{o.priority}</span>
                    )}
                    {/*
                      The order number, where a doctor comes back to look it up.

                      Ordering shows it once and the sheet closes; this is the
                      only other place the person who raised it can find it, and
                      it is what they will read out to the laboratory or match
                      against an invoice.
                    */}
                    {o.accession && (
                      <span className="font-mono text-xxs font-semibold text-primary">
                        {o.accession}
                      </span>
                    )}
                    <span className="ml-auto text-xxs text-text-subtle">
                      {dateTime(o.orderedAt)} · {o.requestedBy}
                    </span>
                  </div>

                  {/* The bare "partner lab" tag that used to sit above said the
                      order had left the building and not which lab it went to
                      nor whether anything had come back. */}
                  <RoutingRow trail={o.routing} />

                  {/*
                    Charged by whoever is running it, not by us.
                    ---------------------------------------------
                    Said in words because the alternative is a blank, and a
                    blank is read as "nobody got round to pricing this" — which
                    is a different fact and the one every unpriced-work figure
                    in the system is built to catch. If the two render the same
                    way, the real ones stop being noticed.

                    Per order rather than per line: the arrangement belongs to
                    the partnership, so either the whole order is ours to charge
                    or none of it is.
                  */}
                  {o.items.some((i) => i.payableExternally) && (
                    <p className="mb-2 text-xs text-text-muted">
                      <span className="font-semibold text-text">Payable at the laboratory.</span>{' '}
                      We raised no charge for this — the patient pays the lab that runs it.
                    </p>
                  )}

                  {o.clinicalDetails && (
                    <p className="mb-2 text-xs text-text-muted">{o.clinicalDetails}</p>
                  )}

                  {/* Names the state rather than rendering an empty panel: an
                      unauthorised result and a test that found nothing look
                      identical otherwise. */}
                  <LabAuthorisationNotice order={o} />

                  {o.resultsAuthorised ? (
                    <>
                      {o.items.map((i) => (
                        <LabItemPanel key={i.id} item={i} />
                      ))}
                      <LabAttachments orderId={o.id} canUpload={false} authorised />
                      <div className="mt-2">
                        <Button size="sm" onClick={() => void openDocument('lab-orders', o.id)}>
                          Print report
                        </Button>
                      </div>
                    </>
                  ) : (
                    /* What was asked for is shown even where the answers are
                       withheld — a different question from what came back. */
                    <ul>
                      {o.items.map((i) => (
                        <li key={i.id} className="flex items-baseline gap-2 py-0.5">
                          <span className="font-mono text-xs text-text-muted">{i.testCode}</span>
                          <span className="text-sm">{i.testName}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === 'prescriptions' && (
          <div className="mt-3">
            {!prescriptions && <Skeleton className="h-20" />}
            {prescriptions?.length === 0 && (
              <p className="py-6 text-center text-sm text-text-subtle">No prescriptions yet</p>
            )}
            <div className="space-y-2.5">
              {prescriptions?.map((p) => (
                <div key={p.id} className="rounded-sm border border-border p-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold">{dateTime(p.issuedAt)}</span>
                    <span className="font-mono text-xxs text-text-muted">
                      {p.status}
                      {p.dispensedAt ? ' · dispensed' : ''}
                    </span>
                  </div>
                  <RoutingRow trail={p.routing} />
                  <ul className="mt-1 space-y-0.5">
                    {p.items.map((i) => (
                      <li key={i.id} className="font-mono text-xs">
                        {i.medicineName} · {i.dosage} · {i.frequency} · {i.duration}
                      </li>
                    ))}
                  </ul>
                  <div className="mt-1.5 flex items-center gap-3">
                    <button
                      onClick={() => void openDocument('prescriptions', p.id)}
                      className="text-xs text-primary underline-offset-2 hover:underline"
                    >
                      Print
                    </button>

                    {/*
                      Cancel and rewrite, never edit in place.
                      ---------------------------------------
                      A prescription is a contemporaneous clinical record. If it
                      were amended silently, the paper in the patient's hand and
                      the row in the database would disagree — and the pharmacy
                      may already have seen the first version. Cancelling leaves
                      the mistake and the correction both readable, which is what
                      a record is for.

                      Offered only to the doctor who issued it and only before
                      dispensing; the server enforces both, this just avoids
                      showing a button that would be refused.
                    */}
                    {/*
                      Prescribe the same thing again.
                      -------------------------------
                      Offered on EVERY past prescription, including dispensed
                      and cancelled ones — which is the point. "Cancel &
                      rewrite" below only ever appeared before dispensing, so
                      once medicine had actually been handed over there was no
                      action on the row at all, and the commonest real request
                      in general practice — another month of the same tablets —
                      had no button anywhere on the screen.

                      It opens a *new* prescription pre-filled with these
                      lines. It does not touch this one: repeating and
                      correcting are different acts, and the earlier
                      prescription remains exactly what was issued that day.
                    */}
                    {canPrescribe && (
                      <button
                        onClick={() => setRewriteFrom(p)}
                        className="text-xs text-primary hover:underline"
                      >
                        Prescribe again
                      </button>
                    )}

                    {canPrescribe && p.status !== 'CANCELLED' && !p.dispensedAt && (
                      <button
                        onClick={() => setCancelling(p)}
                        className="text-xs text-danger hover:underline"
                      >
                        Cancel &amp; rewrite
                      </button>
                    )}
                    {p.status === 'CANCELLED' && (
                      <span className="text-xs text-text-subtle">Cancelled — not dispensable</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </Card>

      {/* Withdrawing is confirmed, because it is not reversible and the
          pharmacy may already be looking at the prescription. */}
      <ConfirmDialog
        open={cancelling !== null}
        title="Cancel this prescription?"
        consequence={
          cancelling
            ? `Issued ${dateTime(cancelling.issuedAt)}. It stays on the record marked cancelled, and pharmacy will refuse to dispense it. A new prescription opens with the same lines so you can correct them.`
            : ''
        }
        confirmLabel="Cancel prescription"
        onConfirm={() => cancelling && void cancelPrescription(cancelling)}
        onCancel={() => setCancelling(null)}
      />

      {cancelError && (
        <div
          role="alert"
          className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-sm border border-[#f2c4be] bg-danger-soft px-3 py-2 text-sm text-[#8a2a1f] shadow-lg"
          onClick={() => setCancelError(null)}
        >
          {cancelError}
        </div>
      )}

      <RecordSheet
        open={writingRecordFor}
        patientId={id}
        patientName={patient.fullName}
        onClose={() => setWritingRecordFor(false)}
        onSaved={() => {
          setWritingRecordFor(false);
          void api<{ data: MedicalRecord[] }>(`/patients/${id}/records`).then((r) =>
            setRecords(r.data),
          );
        }}
      />

      <LabOrderSheet
        open={requestingTests}
        onClose={() => setRequestingTests(false)}
        patientId={id}
        patientName={patient.fullName}
        onSaved={() => setRequestingTests(false)}
      />

      <PrescriptionSheet
        open={rewriteFrom !== null || writingNew}
        patientId={id}
        patientName={patient.fullName}
        initialItems={rewriteFrom?.items.map((i) => ({
          quantity: i.quantityPrescribed ? String(i.quantityPrescribed) : '',
          medicineName: i.medicineName,
          dosage: i.dosage,
          frequency: i.frequency,
          duration: i.duration,
        }))}
        onClose={() => {
          setRewriteFrom(null);
          setWritingNew(false);
        }}
        onSaved={() => {
          setRewriteFrom(null);
          void api<{ data: Prescription[] }>(`/patients/${id}/prescriptions`).then((r) =>
            setPrescriptions(r.data),
          );
        }}
      />

      {canEdit && (
        <PatientEditSheet
          patient={editing ? patient : null}
          onClose={() => setEditing(false)}
          onSaved={(updated) => {
            setPatient(updated);
            setEditing(false);
            // The list on the left shows the name — keep it in step.
            onRenamed();
          }}
        />
      )}

      {!canSeeClinical && (
        <Card className="mt-3 border-dashed bg-[#fafbfc]">
          <p className="text-xs leading-relaxed text-text-muted">
            <strong className="text-text">Note —</strong> your role receives demographic fields
            only. Allergies, blood group, diagnoses and prescriptions are absent from this
            response; they are not hidden client-side.
          </p>
        </Card>
      )}
    </>
  );
}

/**
 * Where this went, and what came back.
 *
 * On the row rather than behind a click: "did this actually reach the pharmacy"
 * is the question a doctor opens a history with, and an answer that needs a
 * second interaction is one most people never see.
 */
function RoutingRow({ trail }: { trail?: RoutingTrail }) {
  const line = routingLine(trail, (iso) => dateTime(iso));
  if (!line) return null;

  return (
    <div className="mt-1 flex flex-wrap items-baseline gap-x-1.5 text-xs">
      <span className="text-text-subtle">Sent to</span>
      <span className="font-medium text-text">{line.where}</span>
      <span className={line.needsAction ? 'font-medium text-danger' : 'text-text-muted'}>
        · {line.outcome}
      </span>
    </div>
  );
}


function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <>
      <dt className="text-xs text-text-subtle">{label}</dt>
      <dd className={mono ? 'font-mono text-xs' : ''}>{value}</dd>
    </>
  );
}
