import { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { api } from '@/lib/api';
import { date, time } from '@/lib/format';
import { theme } from '@/lib/theme';
import { Button, Card, ErrorBanner, Screen } from '@/components/ui';
import { AllergyBanner } from '@/components/allergy-banner';
import { PrescriptionSheet } from '@/components/prescription-sheet';
import { RecordSheet } from '@/components/record-sheet';
import { routingLine } from '@/lib/routing-line';
import type { RoutingTrail } from '@/lib/types';
import { openLabAttachment, shareDocument } from '@/lib/documents';
import type { LabAttachment, LabOrder, MedicalRecord, Patient, Prescription } from '@/lib/types';

/**
 * Patient summary — read-only, deliberately partial.
 *
 * Allergies, active medication, the last visit, and two actions. Not the full
 * history: reviewing years of records on a phone is a bad experience that
 * would take real effort to build badly, and it is a desk task. The screen
 * says so rather than leaving the doctor hunting for a tab that does not exist.
 */
export default function PatientScreen() {
  /*
   * `?prescribe=1` opens the sheet on arrival.
   *
   * The queue's Prescription button navigates here rather than opening an
   * overlay on top of a list — the prescribing sheet needs the patient's
   * allergies and history, which this screen already loads, and duplicating
   * that fetch on the queue would be a second place for it to drift.
   */
  const { id, prescribe } = useLocalSearchParams<{ id: string; prescribe?: string }>();
  const patientId = Number(id);
  const router = useRouter();

  const [patient, setPatient] = useState<Patient | null>(null);
  const [records, setRecords] = useState<MedicalRecord[] | null>(null);
  const [prescriptions, setPrescriptions] = useState<Prescription[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [writingRx, setWritingRx] = useState(prescribe === '1');
  const [writingRecord, setWritingRecord] = useState(false);
  /** Lines carried into a fresh prescription after one is withdrawn. */
  const [rewriteFrom, setRewriteFrom] = useState<Prescription | null>(null);
  const [labOrders, setLabOrders] = useState<LabOrder[] | null>(null);
  /** Files per order, fetched only for reports the laboratory has authorised. */
  const [labFiles, setLabFiles] = useState<Record<number, LabAttachment[]>>({});

  const reloadLabOrders = () =>
    api<{ data: LabOrder[] }>(`/patients/${patientId}/lab-orders`)
      .then(async (r) => {
        setLabOrders(r.data);
        /*
         * Only for authorised reports. The API withholds files before that, so
         * asking would return an empty list and make "not signed off yet" look
         * like "no files" — the same misreading the values rule avoids.
         */
        const entries = await Promise.all(
          r.data
            .filter((o) => o.resultsAuthorised)
            .map(async (o) => {
              try {
                const files = await api<{ data: LabAttachment[] }>(
                  `/lab/orders/${o.id}/attachments`,
                );
                return [o.id, files.data] as const;
              } catch {
                return [o.id, [] as LabAttachment[]] as const;
              }
            }),
        );
        setLabFiles(Object.fromEntries(entries));
      })
      .catch(() => setLabOrders([]));

  /**
   * Retract a request.
   *
   * A reason is required and kept: a cancelled test with none is
   * indistinguishable from one cancelled by accident, and the person who finds
   * it is the next clinician wondering why no result came.
   */
  const cancelLabOrder = (order: LabOrder) => {
    Alert.prompt?.(
      'Cancel request',
      order.collectedAt
        ? 'A sample has already been taken, so the charge stands — the work was real. Why is it being cancelled?'
        : 'Nothing has been collected yet, so the charge is voided with it. Why is it being cancelled?',
      async (reason?: string) => {
        if (!reason || reason.trim().length < 6) return;
        try {
          await api(`/lab-orders/${order.id}/cancel`, {
            method: 'PATCH',
            body: { reason: reason.trim() },
          });
          await reloadLabOrders();
        } catch (e) {
          setError(e instanceof Error ? e.message : 'Could not cancel that request');
        }
      },
    );
  };

  const reloadPrescriptions = () =>
    api<{ data: Prescription[] }>(`/patients/${patientId}/prescriptions`)
      .then((r) => setPrescriptions(r.data))
      .catch(() => {});

  const reloadRecords = () =>
    api<{ data: MedicalRecord[] }>(`/patients/${patientId}/records`)
      .then((r) => setRecords(r.data))
      .catch(() => {});

  /**
   * Withdraw a prescription, then open a new one on the same lines.
   *
   * NOT AN EDIT, AND THAT IS THE POINT
   * ----------------------------------
   * A prescription is a contemporaneous clinical record. Amending one in place
   * would let the paper in the patient's hand disagree with the row in the
   * database — and pharmacy may already have seen the first version. Cancelling
   * leaves the mistake and the correction both readable, which is what a record
   * is for.
   *
   * The server refuses once anything has been dispensed, and refuses a
   * prescription this doctor did not issue. Both messages are shown as-is.
   */
  const cancelAndRewrite = (p: Prescription) => {
    Alert.alert(
      'Cancel this prescription?',
      `Issued ${date(p.issuedAt)}. It stays on the record marked cancelled, and pharmacy will refuse to dispense it. A new prescription opens with the same lines so you can correct them.`,
      [
        { text: 'Keep it', style: 'cancel' },
        {
          text: 'Cancel prescription',
          style: 'destructive',
          onPress: async () => {
            try {
              await api(`/prescriptions/${p.id}/cancel`, { method: 'PATCH' });
              await reloadPrescriptions();
              setRewriteFrom(p);
              setWritingRx(true);
            } catch (e) {
              Alert.alert(
                'Could not cancel',
                e instanceof Error ? e.message : 'Please try again.',
              );
            }
          },
        },
      ],
    );
  };

  useEffect(() => {
    if (!Number.isInteger(patientId)) return;
    api<Patient>(`/patients/${patientId}`)
      .then(setPatient)
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load this patient'));
    api<{ data: MedicalRecord[] }>(`/patients/${patientId}/records`)
      .then((r) => setRecords(r.data))
      .catch(() => setRecords([]));
    api<{ data: Prescription[] }>(`/patients/${patientId}/prescriptions`)
      .then((r) => setPrescriptions(r.data))
      .catch(() => setPrescriptions([]));
    void reloadLabOrders();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patientId]);

  const active = (prescriptions ?? []).filter((p) => p.status !== 'CANCELLED').slice(0, 3);

  return (
    <Screen>
      <Stack.Screen options={{ headerShown: false }} />

      <View style={s.header}>
        <Text style={s.back} onPress={() => router.back()}>
          ‹ Queue
        </Text>
        <Text style={s.name}>{patient?.fullName ?? '…'}</Text>
        {patient && (
          <Text style={s.meta}>
            {patient.age}y · {patient.gender.toLowerCase()}
            {patient.bloodGroup ? ` · ${patient.bloodGroup}` : ''} · #{patient.id}
          </Text>
        )}
      </View>

      {error && <ErrorBanner message={error} />}

      <ScrollView contentContainerStyle={s.body}>
        {patient && <AllergyBanner allergies={patient.allergies} />}

        <Text style={s.section}>Active medication</Text>
        {active.length === 0 ? (
          <Card>
            <Text style={s.muted}>
              {prescriptions === null ? 'Loading…' : 'None recorded.'}
            </Text>
          </Card>
        ) : (
          active.map((p) => (
            <Card key={p.id}>
              {p.items.map((i) => (
                <Text key={i.id} style={s.mono}>
                  {i.medicineName} · {i.dosage} · {i.frequency}
                </Text>
              ))}
              <Text style={s.muted}>
                Issued {date(p.issuedAt)}
                {p.dispensedAt ? ' · dispensed' : ''}
              </Text>
              <RoutingLine trail={p.routing} />

              {/*
                Two different acts, and only one of them was available.

                "Prescribe again" opens a new prescription on these lines and
                leaves this one alone — the commonest request in practice,
                another month of the same tablets. It is offered on every row
                including dispensed ones, which is exactly where it was
                missing: once medicine had been handed over there was no
                action on the row at all.

                "Cancel & rewrite" withdraws this prescription and replaces
                it, so it stays limited to before dispensing. The server
                refuses either way.
              */}
              <View style={s.rxActions}>
                <Button
                  label="Prescribe again"
                  variant="secondary"
                  size="sm"
                  onPress={() => {
                    setRewriteFrom(p);
                    setWritingRx(true);
                  }}
                />
                {!p.dispensedAt && p.status !== 'CANCELLED' && (
                  <Button
                    label="Cancel & rewrite"
                    variant="secondary"
                    size="sm"
                    onPress={() => cancelAndRewrite(p)}
                  />
                )}
              </View>
            </Card>
          ))
        )}

        <Text style={s.section}>Last visit</Text>
        <Card>
          {records === null ? (
            <Text style={s.muted}>Loading…</Text>
          ) : records.length === 0 ? (
            <Text style={s.muted}>First visit.</Text>
          ) : (
            <>
              <Text style={s.recordDate}>{date(records[0].visitDate)}</Text>
              <Text style={s.recordDiagnosis}>{records[0].diagnosis}</Text>
              {records[0].notes && <Text style={s.muted}>{records[0].notes}</Text>}
            </>
          )}
        </Card>

        {/*
          Investigations, with the results the laboratory has authorised.

          Values that have not been authorised are withheld by the API and the
          card says so rather than rendering an empty panel — an unverified
          result and a test that found nothing look identical otherwise, which
          is the most dangerous available misreading.
        */}
        <Text style={s.section}>Investigations</Text>
        {labOrders === null ? (
          <Card>
            <Text style={s.muted}>Loading…</Text>
          </Card>
        ) : labOrders.length === 0 ? (
          <Card>
            <Text style={s.muted}>Nothing requested.</Text>
          </Card>
        ) : (
          labOrders.slice(0, 8).map((o) => (
            <Card key={o.id} style={s.labCard}>
              <Text style={s.recordDate}>
                {o.accession ? `${o.accession} · ` : ''}
                {date(o.orderedAt)} · {o.status.toLowerCase().replace('_', ' ')}
              </Text>
              {/* Which lab, and whether anything came back. "partner lab" on
                  its own said it had left the building and nothing else. */}
              <RoutingLine trail={o.routing} />
              {/*
                Charged by whoever is running it, not by us.

                Said in words because the alternative is a blank, and a blank
                reads as "nobody got round to pricing this" — a different fact,
                and the one every unpriced-work figure in this system exists to
                catch. If the two look the same, the real ones stop being
                noticed.

                Per order rather than per line: the arrangement belongs to the
                partnership, so either the whole order is ours to charge or
                none of it is.
              */}
              {o.items.some((i) => i.payableExternally) && (
                <Text style={s.muted}>
                  Payable at the laboratory — we raised no charge for this.
                </Text>
              )}
              {o.items.map((i) => (
                <View key={i.id}>
                  <Text style={s.recordDiagnosis}>{i.testName}</Text>
                  {o.resultsAuthorised ? (
                    <>
                      {i.values.map((v) => (
                        <Text key={v.id} style={v.critical ? s.labCritical : s.muted}>
                          {v.analyteName} {v.value}
                          {v.unit ? ` ${v.unit}` : ''}
                          {v.referenceRange ? `  (${v.referenceRange})` : ''}
                          {v.abnormal ? '  ⚠' : ''}
                        </Text>
                      ))}
                      {i.impression ? <Text style={s.muted}>{i.impression}</Text> : null}
                    </>
                  ) : null}
                </View>
              ))}

              {!o.resultsAuthorised && o.status !== 'CANCELLED' && o.status !== 'REJECTED' ? (
                <Text style={s.muted}>
                  Not reported yet. Results appear once the laboratory has authorised them.
                </Text>
              ) : null}
              {o.status === 'REJECTED' && o.rejectReason ? (
                <Text style={s.labCritical}>
                  Sample could not be used — another is needed. {o.rejectReason}
                </Text>
              ) : null}
              {o.status === 'CANCELLED' && o.cancelReason ? (
                <Text style={s.muted}>Cancelled — {o.cancelReason}</Text>
              ) : null}

              {(labFiles[o.id] ?? []).map((f) => (
                <Pressable key={f.id} onPress={() => void openLabAttachment(f.id)}>
                  {/* The laboratory's own document, not the one this system
                      renders. For histopathology and imaging it is the report;
                      the impression above is a summary of it. */}
                  <Text style={s.fileLink}>📎 {f.fileName}</Text>
                </Pressable>
              ))}

              <View style={s.rxActions}>
                {o.resultsAuthorised && (
                  <Button
                    label="Share report"
                    variant="secondary"
                    size="sm"
                    onPress={() => void shareDocument('lab-orders', o.id)}
                  />
                )}
                {/* Retracting a request, with a caller in the same change that
                    added the endpoint — `PATCH /prescriptions/:id/cancel` has
                    been correct and unreachable since Phase 4. */}
                {o.status !== 'VERIFIED' && o.status !== 'CANCELLED' && (
                  <Button
                    label="Cancel request"
                    variant="secondary"
                    size="sm"
                    onPress={() => cancelLabOrder(o)}
                  />
                )}
              </View>
            </Card>
          ))
        )}

        <Text style={s.footnote}>
          Full history, records and appointment management are on the web app.
        </Text>
      </ScrollView>

      <View style={s.actions}>
        {/* The consultation note. Web has offered this from the patient record
            and the queue since Phase 1; the phone had it in neither place. */}
        <Button label="Add record" variant="secondary" onPress={() => setWritingRecord(true)} />
        <Button label="Write prescription" onPress={() => setWritingRx(true)} />
        <Button
          label="Request tests"
          variant="secondary"
          onPress={() =>
            router.push(
              `/lab-order/${patientId}?patientName=${encodeURIComponent(patient?.fullName ?? '')}`,
            )
          }
        />
      </View>

      {patient && (
        <>
        <RecordSheet
          visible={writingRecord}
          patientId={Number(patientId)}
          patientName={patient?.fullName ?? ''}
          onClose={() => setWritingRecord(false)}
          // Reload so the new note appears in the list behind the sheet — a
          // record that does not show up reads as one that did not save.
          onSaved={() => void reloadRecords()}
        />

        <PrescriptionSheet
          visible={writingRx}
          initialItems={rewriteFrom?.items.map((i) => ({
            medicineName: i.medicineName,
            dosage: i.dosage,
            frequency: i.frequency,
            duration: i.duration,
            quantity: i.quantityPrescribed ? String(i.quantityPrescribed) : '',
          }))}
          patientId={patient.id}
          patientName={patient.fullName}
          allergies={patient.allergies}
          onClose={() => {
            setWritingRx(false);
            setRewriteFrom(null);
          }}
          onIssued={() => {
            setWritingRx(false);
            setRewriteFrom(null);
            api<{ data: Prescription[] }>(`/patients/${patientId}/prescriptions`)
              .then((r) => setPrescriptions(r.data))
              .catch(() => {});
          }}
        />
        </>
      )}
    </Screen>
  );
}

/**
 * Where this went and what came back, worded by the shared `routingLine` so the
 * phone and the desk cannot tell a doctor two different stories about the same
 * prescription.
 */
function RoutingLine({ trail }: { trail?: RoutingTrail }) {
  const line = routingLine(trail, (iso) => date(iso));
  if (!line) return null;

  return (
    <Text style={line.needsAction ? s.routingAlert : s.muted}>
      → {line.where} · {line.outcome}
    </Text>
  );
}

const s = StyleSheet.create({
  routingAlert: { ...theme.font.caption, color: theme.color.danger },
  labCard: { gap: theme.space(0.5) },
  /* Critical is not a stronger shade of abnormal — it is the row somebody has
     to telephone about. */
  labCritical: { ...theme.font.caption, color: theme.color.danger, fontWeight: '700' },
  fileLink: { ...theme.font.caption, color: theme.color.primary, marginTop: theme.space(0.5) },
  header: {
    paddingHorizontal: theme.space(4),
    paddingBottom: theme.space(2),
    backgroundColor: theme.color.surface,
    borderBottomWidth: 1,
    borderBottomColor: theme.color.border,
  },
  back: { color: theme.color.primary, ...theme.font.body, marginBottom: 4 },
  name: { ...theme.font.display, color: theme.color.text },
  meta: { ...theme.font.small, color: theme.color.textMuted, fontVariant: ['tabular-nums'] },
  body: { padding: theme.space(3), paddingBottom: theme.space(6) },
  section: {
    ...theme.font.caption,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: theme.color.textSubtle,
    marginTop: theme.space(3),
    marginBottom: theme.space(2),
  },
  muted: { ...theme.font.small, color: theme.color.textMuted },
  rxActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 },
  mono: { ...theme.font.body, color: theme.color.text },
  recordDate: { ...theme.font.small, color: theme.color.text },
  recordDiagnosis: { ...theme.font.body, color: theme.color.text, marginVertical: 2 },
  footnote: {
    ...theme.font.caption,
    color: theme.color.textSubtle,
    textAlign: 'center',
    marginTop: theme.space(5),
  },
  actions: {
    padding: theme.space(3),
    borderTopWidth: 1,
    borderTopColor: theme.color.border,
    backgroundColor: theme.color.surface,
  },
});
