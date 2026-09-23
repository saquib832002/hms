import { useCallback, useEffect, useState } from 'react';
import { FlatList, Modal, Pressable, RefreshControl, StyleSheet, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { api } from '@/lib/api';
import { useLiveData } from '@/lib/use-live-data';
import { theme } from '@/lib/theme';
import { date, time } from '@/lib/format';
import { AppHeader, Button, Card, EmptyState, ErrorBanner, Screen } from '@/components/ui';
import type { MedicationRequest, Prescription } from '@/lib/types';

/**
 * Medication requests from the wards, for a prescriber.
 *
 * A nurse has asked for something not on the patient's chart. Two ways to close
 * it: write the prescription through the ordinary route and link it, or decline
 * with a reason.
 *
 * WHY THERE IS NO "APPROVE" BUTTON
 * --------------------------------
 * A one-tap approve creating the prescription from the nurse's text reads as a
 * convenience and is prescribing by autocomplete — the medicine, dose and
 * frequency would originate from the person not licensed to choose them, with a
 * prescriber's name attached. So the doctor writes it normally and links it
 * here by id, and the server checks that prescription exists and belongs to
 * this patient.
 *
 * Every open request in the hospital, not only this doctor's own patients: ward
 * cover means the doctor answering at 3am is routinely not the admitting one.
 */
const TABS = ['waiting', 'prescribed', 'declined'] as const;
type Tab = (typeof TABS)[number];

export default function MedicationRequestsScreen() {
  const [tab, setTab] = useState<Tab>('waiting');
  const [rows, setRows] = useState<MedicationRequest[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [answering, setAnswering] = useState<MedicationRequest | null>(null);
  const [declining, setDeclining] = useState<MedicationRequest | null>(null);
  const router = useRouter();

  const load = useCallback(async () => {
    setError(null);
    try {
      setRows(await api<MedicationRequest[]>(`/medication-requests?status=${tab}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load requests');
    }
  }, [tab]);

  useLiveData(load);

  return (
    <Screen>
      <AppHeader title="Ward requests" subtitle="Nurses asking for a prescription" />

      <View style={s.tabs}>
        {TABS.map((t) => (
          <Pressable key={t} onPress={() => setTab(t)} style={[s.tab, tab === t && s.tabActive]}>
            <Text style={[s.tabText, tab === t && s.tabTextActive]}>{t}</Text>
          </Pressable>
        ))}
      </View>

      {error && <ErrorBanner message={error} />}

      <FlatList
        data={rows}
        keyExtractor={(r) => String(r.id)}
        contentContainerStyle={s.list}
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
          <EmptyState
            glyph="✎"
            title={tab === 'waiting' ? 'Nothing waiting' : `No ${tab} requests`}
            body={
              tab === 'waiting'
                ? 'Nurses ask here when a patient needs something not prescribed.'
                : undefined
            }
          />
        }
        renderItem={({ item: r }) => (
          <Card>
            <Text style={s.name}>{r.admission.patient.fullName}</Text>
            <Text style={s.muted}>
              {r.admission.bed?.label ?? '—'} · {r.admission.bed?.ward?.name ?? ''}
            </Text>

            {/*
              Allergies before the ask, not after. The prescriber is about to
              decide whether to write something and this is the first thing
              they need — below the request means read second.
            */}
            {r.admission.patient.allergies.length > 0 && (
              <View style={s.allergy}>
                <Text style={s.allergyText}>
                  ⚠ Allergic to: {r.admission.patient.allergies.map((a) => a.substance).join(', ')}
                </Text>
              </View>
            )}

            <Text style={s.asked}>{r.medicineText}</Text>
            <Text style={s.muted}>{r.reason}</Text>
            <Text style={s.stamp}>
              {`${date(r.requestedAt)} ${time(r.requestedAt)}`}
              {r.requestedBy ? ` · ${r.requestedBy.fullName}` : ''}
            </Text>

            {r.responseNote ? (
              <Text style={s.answer}>
                {r.respondedBy ? `${r.respondedBy.fullName}: ` : ''}
                {r.responseNote}
              </Text>
            ) : null}

            {r.status === 'REQUESTED' && (
              <View style={{ marginTop: theme.space(3), gap: theme.space(2) }}>
                {/*
                  Writing it happens on the patient screen, which is the one
                  prescribing path. A second one reachable from here is how
                  "the nurse never prescribes" quietly stops being true.
                */}
                <Button
                  label="Open the patient to write it"
                  variant="secondary"
                  onPress={() => router.push(`/(tabs)/patient/${r.admission.patient.id}` as never)}
                />
                <Button label="I have prescribed it" onPress={() => setAnswering(r)} />
                <Button label="Decline" variant="secondary" onPress={() => setDeclining(r)} />
              </View>
            )}
          </Card>
        )}
      />

      <LinkModal
        request={answering}
        onClose={() => setAnswering(null)}
        onDone={() => {
          setAnswering(null);
          void load();
        }}
        onError={setError}
      />

      <DeclineModal
        request={declining}
        onClose={() => setDeclining(null)}
        onDone={() => {
          setDeclining(null);
          void load();
        }}
        onError={setError}
      />
    </Screen>
  );
}

/** Closing a request against a prescription that already exists. */
function LinkModal({
  request,
  onClose,
  onDone,
  onError,
}: {
  request: MedicationRequest | null;
  onClose: () => void;
  onDone: () => void;
  onError: (m: string) => void;
}) {
  const [options, setOptions] = useState<Prescription[] | null>(null);
  const [chosen, setChosen] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const patientId = request?.admission.patient.id;

  useEffect(() => {
    setOptions(null);
    setChosen(null);
    if (!patientId) return;
    api<{ data: Prescription[] }>(`/patients/${patientId}/prescriptions`)
      .then((r) => {
        const usable = r.data.filter((p) => p.status !== 'CANCELLED');
        setOptions(usable);
        setChosen(usable[0]?.id ?? null);
      })
      .catch(() => setOptions([]));
  }, [patientId]);

  if (!request) return null;

  async function save() {
    if (!request || !chosen) return;
    setBusy(true);
    try {
      await api(`/medication-requests/${request.id}/fulfil`, {
        method: 'POST',
        body: { prescriptionId: chosen },
      });
      onDone();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Could not close that request');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <View style={s.modalRoot}>
        <Pressable style={s.modalBackdrop} onPress={onClose} />
        <View style={s.modalCard}>
          <Text style={s.asked}>{request.medicineText}</Text>
          <Text style={s.muted}>{request.admission.patient.fullName}</Text>

          <Text style={s.label}>Which prescription answers this</Text>
          {options?.length === 0 ? (
            <Text style={s.hint}>
              No prescriptions to link. Write one first — the request stays waiting until you do.
            </Text>
          ) : (
            (options ?? []).map((p) => (
              <Pressable
                key={p.id}
                onPress={() => setChosen(p.id)}
                style={[s.option, chosen === p.id && s.optionActive]}
              >
                <Text style={s.optionText}>
                  #{p.id} · {p.items.map((i) => i.medicineName).join(', ')}
                </Text>
              </Pressable>
            ))
          )}

          <View style={{ marginTop: theme.space(3) }}>
            <Button label="Close the request" onPress={() => void save()} disabled={busy || !chosen} />
          </View>
          <Button
            label="Cancel"
            variant="secondary"
            onPress={onClose}
            style={{ marginTop: theme.space(2) }}
          />
        </View>
      </View>
    </Modal>
  );
}

/** Declining, and the reason is kept forever. */
function DeclineModal({
  request,
  onClose,
  onDone,
  onError,
}: {
  request: MedicationRequest | null;
  onClose: () => void;
  onDone: () => void;
  onError: (m: string) => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  if (!request) return null;

  async function save() {
    if (!request) return;
    setBusy(true);
    try {
      await api(`/medication-requests/${request.id}/decline`, {
        method: 'POST',
        body: { reason: reason.trim() },
      });
      setReason('');
      onDone();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Could not decline that request');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <View style={s.modalRoot}>
        <Pressable style={s.modalBackdrop} onPress={onClose} />
        <View style={s.modalCard}>
          <Text style={s.asked}>{request.medicineText}</Text>
          <Text style={s.muted}>{request.reason}</Text>

          <Text style={s.label}>Why</Text>
          <TextInput
            style={s.input}
            value={reason}
            onChangeText={setReason}
            placeholder="Already covered by the 14:00 antiemetic — review if still symptomatic."
            placeholderTextColor={theme.color.textSubtle}
            multiline
            autoFocus
          />
          <Text style={s.hint}>The ward sees this and it stays on record.</Text>

          <Button
            label="Decline"
            variant="danger"
            onPress={() => void save()}
            disabled={busy || reason.trim().length < 5}
          />
          <Button
            label="Cancel"
            variant="secondary"
            onPress={onClose}
            style={{ marginTop: theme.space(2) }}
          />
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  tabs: { flexDirection: 'row', gap: theme.space(2), paddingHorizontal: theme.space(4), paddingTop: theme.space(3) },
  tab: {
    paddingHorizontal: theme.space(3),
    paddingVertical: theme.space(1),
    borderRadius: 999,
    backgroundColor: theme.color.bg,
    borderWidth: 1,
    borderColor: theme.color.border,
  },
  tabActive: { backgroundColor: theme.color.primarySoft, borderColor: theme.color.primary },
  tabText: { fontSize: 12, color: theme.color.textMuted, textTransform: 'capitalize' },
  tabTextActive: { color: theme.color.primary, fontWeight: '700' },
  list: { padding: theme.space(4), gap: theme.space(3) },
  name: { fontSize: 15, fontWeight: '700', color: theme.color.text },
  asked: { fontSize: 15, fontWeight: '700', color: theme.color.text, marginTop: theme.space(2) },
  muted: { fontSize: 12, color: theme.color.textMuted, marginTop: 2 },
  stamp: { fontSize: 11, color: theme.color.textSubtle, marginTop: theme.space(2) },
  allergy: {
    marginTop: theme.space(2),
    backgroundColor: theme.color.dangerSoft,
    borderRadius: theme.radius.sm,
    padding: theme.space(2),
  },
  allergyText: { color: theme.color.danger, fontSize: 12, fontWeight: '600' },
  answer: {
    fontSize: 12,
    color: theme.color.text,
    marginTop: theme.space(2),
    paddingTop: theme.space(2),
    borderTopWidth: 1,
    borderTopColor: theme.color.border,
  },
  option: {
    borderWidth: 1,
    borderColor: theme.color.border,
    borderRadius: theme.radius.sm,
    padding: theme.space(3),
    marginBottom: theme.space(2),
  },
  optionActive: { borderColor: theme.color.primary, backgroundColor: theme.color.primarySoft },
  optionText: { fontSize: 13, color: theme.color.text },
  modalRoot: { flex: 1, justifyContent: 'flex-end' },
  modalBackdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.35)' },
  modalCard: {
    backgroundColor: theme.color.surface,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: theme.space(5),
  },
  label: {
    fontSize: 12,
    fontWeight: '600',
    color: theme.color.text,
    marginTop: theme.space(3),
    marginBottom: theme.space(1),
  },
  hint: { fontSize: 11, color: theme.color.textSubtle, marginBottom: theme.space(3) },
  input: {
    borderWidth: 1,
    borderColor: theme.color.border,
    borderRadius: theme.radius.sm,
    padding: theme.space(3),
    color: theme.color.text,
    backgroundColor: theme.color.bg,
  },
});
