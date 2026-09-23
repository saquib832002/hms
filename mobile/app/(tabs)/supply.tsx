import { useCallback, useState } from 'react';
import { FlatList, Modal, Pressable, RefreshControl, StyleSheet, Text, TextInput, View } from 'react-native';
import { api } from '@/lib/api';
import { useLiveData } from '@/lib/use-live-data';
import { theme } from '@/lib/theme';
import { date, time } from '@/lib/format';
import { AppHeader, Button, Card, EmptyState, ErrorBanner, Screen } from '@/components/ui';
import type { SupplyRequest } from '@/lib/types';

/**
 * Ward supply requests, for the pharmacist.
 *
 * A ward asking for stock of something a doctor has already prescribed — a
 * logistics queue, not a clinical one. The clinical decision was made when the
 * prescription was written; the only question here is whether the pharmacy
 * sends it.
 *
 * The other request a nurse can raise — for something not prescribed at all —
 * goes to a doctor. Two queues on purpose: merging them routes half of each to
 * the wrong person, and the failure that makes available is a drug supplied
 * that nobody prescribed.
 *
 * **Marking supplied moves no stock.** The medicine leaves the shelf through
 * dispensing, where batch, expiry, allergy and price are all handled and
 * counted once. A decrement here would be a second stock ledger.
 *
 * Segmented rather than filtered to the open items, for the third time in this
 * codebase: "did that insulin ever go up to the ward" is asked precisely once
 * the row would have vanished from a waiting-only list.
 */
const TABS = ['waiting', 'supplied', 'declined'] as const;
type Tab = (typeof TABS)[number];

export default function SupplyQueueScreen() {
  const [tab, setTab] = useState<Tab>('waiting');
  const [rows, setRows] = useState<SupplyRequest[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [declining, setDeclining] = useState<SupplyRequest | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setRows(await api<SupplyRequest[]>(`/supply-requests?status=${tab}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load supply requests');
    }
  }, [tab]);

  useLiveData(load);

  async function supply(r: SupplyRequest) {
    setBusy(true);
    try {
      await api(`/supply-requests/${r.id}/supply`, { method: 'POST', body: {} });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not mark that supplied');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <AppHeader title="Ward supply" subtitle="Stock the wards have asked for" />

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
            glyph="⇧"
            title={tab === 'waiting' ? 'Nothing waiting' : `No ${tab} requests`}
            body={
              tab === 'waiting'
                ? 'Wards ask here when they have run out of something already prescribed.'
                : undefined
            }
          />
        }
        renderItem={({ item: r }) => (
          <Card>
            {/*
              The patient is named. That is how the wrong medicine going to the
              wrong bed is caught at the counter rather than at the bedside.
            */}
            <Text style={s.name}>{r.admission.patient.fullName}</Text>
            <Text style={s.muted}>
              {r.admission.bed?.label ?? '—'} · {r.admission.bed?.ward?.name ?? ''}
            </Text>

            <Text style={s.medicine}>{r.prescriptionItem.medicineName}</Text>
            <Text style={s.muted}>
              {r.prescriptionItem.dosage} · {r.prescriptionItem.frequency}
              {r.quantity ? ` · ${r.quantity} asked for` : ''}
            </Text>
            {r.note ? <Text style={s.note}>{r.note}</Text> : null}
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
                <Button label="Supplied" onPress={() => void supply(r)} disabled={busy} />
                <Button label="Decline" variant="secondary" onPress={() => setDeclining(r)} />
              </View>
            )}
          </Card>
        )}
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

/**
 * Declining with a reason the ward can act on.
 *
 * "Out of stock, expect Thursday" changes what the nurse does next; a bare
 * refusal sends them to the phone, which is what this queue replaces.
 */
function DeclineModal({
  request,
  onClose,
  onDone,
  onError,
}: {
  request: SupplyRequest | null;
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
      await api(`/supply-requests/${request.id}/decline`, {
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
          <Text style={s.medicine}>{request.prescriptionItem.medicineName}</Text>
          <Text style={s.muted}>{request.admission.patient.fullName}</Text>

          <Text style={s.label}>Why</Text>
          <TextInput
            style={s.input}
            value={reason}
            onChangeText={setReason}
            placeholder="Out of stock, ordered, expect Thursday"
            placeholderTextColor={theme.color.textSubtle}
            multiline
            autoFocus
          />
          <Text style={s.hint}>The ward sees this. Say what they should do next.</Text>

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
  medicine: { fontSize: 15, fontWeight: '700', color: theme.color.text, marginTop: theme.space(2) },
  muted: { fontSize: 12, color: theme.color.textMuted, marginTop: 2 },
  note: { fontSize: 12, color: theme.color.text, marginTop: theme.space(2) },
  stamp: { fontSize: 11, color: theme.color.textSubtle, marginTop: theme.space(2) },
  answer: {
    fontSize: 12,
    color: theme.color.text,
    marginTop: theme.space(2),
    paddingTop: theme.space(2),
    borderTopWidth: 1,
    borderTopColor: theme.color.border,
  },
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
