'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { useUser } from '@/lib/auth-context';
import type { MedicalRecord, Paginated, Patient, PatientListItem, Prescription } from '@/lib/types';
import { date, dateTime } from '@/lib/format';
import { Card, EmptyState, ErrorState, Input, Skeleton } from '@/components/ui/primitives';
import { AllergyBanner } from '@/components/allergy-banner';
import { Button } from '@/components/ui/primitives';
import { PatientEditSheet } from '@/components/patient-edit-sheet';

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
  canEdit,
  onRenamed,
}: {
  id: number;
  canSeeClinical: boolean;
  canEdit: boolean;
  onRenamed: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [patient, setPatient] = useState<Patient | null>(null);
  const [records, setRecords] = useState<MedicalRecord[] | null>(null);
  const [prescriptions, setPrescriptions] = useState<Prescription[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'overview' | 'records' | 'prescriptions'>('overview');

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
    if (canSeeClinical) {
      api<{ data: MedicalRecord[] }>(`/patients/${id}/records`)
        .then((r) => setRecords(r.data))
        .catch(() => setRecords([]));
      api<{ data: Prescription[] }>(`/patients/${id}/prescriptions`)
        .then((r) => setPrescriptions(r.data))
        .catch(() => setPrescriptions([]));
    }
  }, [id, canSeeClinical]);

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
              ...(canSeeClinical
                ? ([
                    ['records', 'Records'],
                    ['prescriptions', 'Prescriptions'],
                  ] as const)
                : []),
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

        {tab === 'overview' && canEdit && (
          <div className="mt-3">
            <Button size="sm" onClick={() => setEditing(true)}>
              Edit details
            </Button>
          </div>
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
                  <div className="text-xs text-text-subtle">{r.doctor?.fullName ?? 'Unknown'}</div>
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
                  <ul className="mt-1 space-y-0.5">
                    {p.items.map((i) => (
                      <li key={i.id} className="font-mono text-xs">
                        {i.medicineName} · {i.dosage} · {i.frequency} · {i.duration}
                      </li>
                    ))}
                  </ul>
                  <a
                    href={`/api/v1/prescriptions/${p.id}/print`}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-1.5 inline-block text-xs text-primary underline-offset-2 hover:underline"
                  >
                    Print
                  </a>
                </div>
              ))}
            </div>
          </div>
        )}
      </Card>

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

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <>
      <dt className="text-xs text-text-subtle">{label}</dt>
      <dd className={mono ? 'font-mono text-xs' : ''}>{value}</dd>
    </>
  );
}
