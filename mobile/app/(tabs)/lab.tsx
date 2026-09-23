import { useCallback, useState } from 'react';
import {
  Alert,
  FlatList,
  Platform,
  Pressable,
  TextInput,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { router } from 'expo-router';
import { api } from '@/lib/api';
import { useLiveData } from '@/lib/use-live-data';
import { theme } from '@/lib/theme';
import { relativeAge, time } from '@/lib/format';
import { AppHeader, Button, Card, ErrorBanner, Screen } from '@/components/ui';
import type { LabWorklistRow } from '@/lib/types';
import { shareDocument } from '@/lib/documents';
import { useMoney } from '@/lib/use-money';
import { useAuth } from '@/lib/auth-context';

/**
 * The laboratory worklist, on a phone.
 *
 * WHAT THIS IS FOR AND WHAT THE DESK IS FOR
 * -----------------------------------------
 * A technician moves between a bench, a centrifuge and a collection room, and
 * the two things they do away from a keyboard are marking a sample taken and
 * checking what is waiting. Both are here.
 *
 * Entering a result is here too, deliberately, and it was a close decision.
 * The tidy rule — "the phone is for looking, the desk is for doing" — is the
 * one this project has now been wrong about four times: reception locked out of
 * mobile behind a false comment, dispensing kept off the web because it happens
 * "at the counter", the medication round left web-read-only, vitals recordable
 * only on a device nobody had. Each was a plausible story about where work
 * happens standing in for the fact that nobody had built the other half.
 *
 * So: a single result, typed at the bench, with the same critical-value stop as
 * the web. What genuinely stays on the desk is the catalogue and the reference
 * ranges, which are configuration set once with a reference book open.
 */
type Segment = 'sendout' | 'pending' | 'collected' | 'resulted' | 'completed';

/**
 * Where a scanned specimen lives on this screen.
 *
 * Derived from the order's own status rather than guessed, so a scan always
 * lands on the list holding the tube. IN_PROGRESS sits with COLLECTED because
 * the distinction is about the bench, and the technician holding the tube is
 * asking "has this been taken yet".
 */
function segmentFor(status: string): Segment {
  if (status === 'ORDERED') return 'pending';
  if (status === 'COLLECTED' || status === 'IN_PROGRESS') return 'collected';
  if (status === 'RESULTED') return 'resulted';
  return 'completed';
}

const SEGMENTS: { key: Segment; label: string }[] = [
  /*
   * Work leaving the building, still ours to draw and hand over.
   *
   * A clinic with a doctor and no bench takes the sample itself and only the
   * tube travels. Every other segment is this hospital's own bench; this one
   * is the specimen, which is why a PARTNER order belongs here and nowhere
   * else — it used to be filtered off the worklist entirely.
   */
  { key: 'sendout', label: 'Send out' },
  { key: 'pending', label: 'To collect' },
  { key: 'collected', label: 'Bench' },
  { key: 'resulted', label: 'Authorise' },
  { key: 'completed', label: 'Done' },
];

export default function LabWorklistScreen() {
  const [segment, setSegment] = useState<Segment>('pending');
  const money = useMoney();
  /*
   * Two clinical roles read this screen. LAB_TECHNICIAN has the till tab;
   * NURSE, who is here for the send-out draw, does not — so the payment button
   * has to know which one is holding the phone.
   */
  const { user } = useAuth();
  const canTakePayment = user?.role === 'LAB_TECHNICIAN' || user?.role === 'ADMIN';
  const [rows, setRows] = useState<LabWorklistRow[] | null>(null);
  const [scan, setScan] = useState('');
  const [scanError, setScanError] = useState<string | null>(null);
  /** The row a scan just landed on, highlighted rather than opened. */
  const [highlight, setHighlight] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [fetchedAt, setFetchedAt] = useState<Date | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api<{ data: LabWorklistRow[] }>(`/lab/worklist?status=${segment}`);
      setRows(res.data);
      setFetchedAt(new Date());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the worklist');
    }
  }, [segment]);

  useLiveData(load);

  /**
   * A specimen number, scanned or typed.
   *
   * The check character is verified on the server before anything is looked
   * up, so a mistyped number is refused rather than resolving to somebody
   * else's specimen — which is the whole reason an accession carries one.
   */
  async function findByAccession() {
    const code = scan.trim();
    if (!code) return;

    setScanError(null);
    try {
      const order = await api<{ id: number; status: string }>(
        `/lab-orders/by-accession/${encodeURIComponent(code)}`,
      );
      setScan('');
      // Jump to the tab the tube is actually in. A technician scanning a rack
      // has no idea which stage each specimen reached, and an empty list reads
      // as the scan having failed.
      setSegment(segmentFor(order.status));
      setHighlight(order.id);
    } catch (e) {
      setScanError(e instanceof Error ? e.message : 'Could not find that specimen');
    }
  }

  /**
   * The tube has gone to the partner laboratory.
   *
   * The referral was transmitted at ordering so the lab could expect the work;
   * this is the specimen actually leaving. Two events, and the second one had
   * nowhere to be recorded.
   */
  const dispatchSpecimen = async (row: LabWorklistRow) => {
    setError(null);
    try {
      await api(`/lab/orders/${row.id}/dispatch`, { method: 'POST', body: {} });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not work');
    }
  };

  const collect = async (row: LabWorklistRow) => {
    try {
      await api(`/lab/orders/${row.id}/collect`, { method: 'POST' });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not record that');
    }
  };

  /**
   * The sample could not be used.
   *
   * Worded as a request for another one rather than as a refusal, because that
   * is what it does — the order goes back to "to collect" rather than ending.
   * A bare "rejected" sends the ward to the telephone.
   */
  const reject = (row: LabWorklistRow) => {
    Alert.prompt?.(
      'Sample unusable',
      `What was wrong? ${row.patient.fullName} needs another sample, and this is what tells them why.`,
      async (reason?: string) => {
        if (!reason || reason.trim().length < 6) return;
        try {
          await api(`/lab/orders/${row.id}/reject`, {
            method: 'POST',
            body: { reason: reason.trim() },
          });
          await load();
        } catch (e) {
          setError(e instanceof Error ? e.message : 'Could not record that');
        }
      },
    );
  };

  /**
   * Authorising also transmits, when the work came from another hospital.
   *
   * `reportedBack` is read rather than ignored, and that is the fix. The API
   * returned it from the day the return leg was built and no client anywhere
   * looked at it — so a failed transmission left the technician looking at an
   * ordinary success while the doctor at the other end waited for a result
   * nobody was sending.
   */
  const verify = (row: LabWorklistRow) => {
    Alert.alert(
      'Authorise report',
      'Until this is done, nobody outside the laboratory can see any of these values. Once it is, they are on the patient’s record.',
      [
        { text: 'Not yet', style: 'cancel' },
        {
          text: 'Authorise',
          onPress: async () => {
            try {
              const res = await api<{
                reportedBack?: boolean;
                reportedBackError?: string | null;
              }>(`/lab/orders/${row.id}/verify`, { method: 'POST', body: {} });
              if (res.reportedBack === false) {
                setError(
                  `Authorised, but the referring hospital was not sent the report: ${
                    res.reportedBackError ?? 'the transmission failed'
                  } — it is under Completed with a Send report again button.`,
                );
              }
              await load();
            } catch (e) {
              setError(e instanceof Error ? e.message : 'Could not authorise that');
            }
          },
        },
      ],
    );
  };

  /**
   * Send it again, after it failed.
   *
   * Nothing else could: `verify` refuses on an order that is already
   * authorised, so an authorised report that never transmitted was stuck for
   * good. Safe to press twice — the server refuses once the other hospital
   * actually has it, because a correction is a new order.
   */
  const reportBack = async (row: LabWorklistRow) => {
    setError(null);
    try {
      const res = await api<{ reportedBack?: boolean; reportedBackError?: string | null }>(
        `/lab/orders/${row.id}/report-back`,
        { method: 'POST', body: {} },
      );
      if (res.reportedBack === false) {
        setError(res.reportedBackError ?? 'The referring hospital still could not be reached');
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not work');
    }
  };

  return (
    <Screen>
      {/*
        Find a specimen by its number.

        NO CAMERA, AND THAT IS A DECISION RATHER THAN A GAP
        ---------------------------------------------------
        A camera scanner would need `expo-camera`, a native permission prompt,
        and hardware nobody here has run this app on. What it would buy over
        typing eleven characters is real but small, and half-building it — a
        button that asks for the camera and then fails on a device — is worse
        than a box that always works.

        Bluetooth ring scanners, which is what phones actually get paired with
        on a ward, present as keyboards and type straight into this box. So the
        common case is already covered. The camera is written down as a gap.
      */}
      <View style={s.scanRow}>
        <TextInput
          style={s.scanInput}
          value={scan}
          onChangeText={setScan}
          onSubmitEditing={() => void findByAccession()}
          placeholder="Scan or type a specimen number"
          placeholderTextColor={theme.color.textSubtle}
          autoCapitalize="characters"
          autoCorrect={false}
          returnKeyType="search"
        />
        <Button label="Find" size="sm" disabled={!scan.trim()} onPress={() => void findByAccession()} />
      </View>

      {scanError && <ErrorBanner message={scanError} />}

      <AppHeader
        title="Worklist"
        subtitle={
          rows === null
            ? `Updated ${relativeAge(fetchedAt)}`
            : // Says which tab it is counting. "3 waiting" over a list of
              // finished work is a wrong number stated confidently.
              `${rows.length} ${SEGMENTS.find((s) => s.key === segment)?.label.toLowerCase()} · ${relativeAge(fetchedAt)}`
        }
      />

      <View style={s.segments}>
        {SEGMENTS.map((seg) => (
          <Pressable
            key={seg.key}
            onPress={() => setSegment(seg.key)}
            style={[s.segment, segment === seg.key && s.segmentOn]}
          >
            <Text style={[s.segmentText, segment === seg.key && s.segmentTextOn]}>{seg.label}</Text>
          </Pressable>
        ))}
      </View>

      {error && <ErrorBanner message={error} />}

      <FlatList
        data={rows ?? []}
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
          // "Loading" and "nothing waiting" look identical as an empty list and
          // mean opposite things.
          <Text style={s.empty}>
            {rows === null
              ? 'Loading…'
              : segment === 'pending'
                ? 'Nothing waiting. Tests appear here as soon as a doctor requests them — ones going to a partner lab are on somebody else’s list.'
                : 'Nothing on this tab.'}
          </Text>
        }
        renderItem={({ item }) => (
          <Card style={highlight === item.id ? { ...s.card, ...s.cardScanned } : s.card}>
            {/*
              The specimen number, above the name and in monospace.

              It is what the technician is holding and what they read out if
              they ring the ward. Reprinting the label is beside it, because a
              label that has smudged, peeled or gone on the wrong tube is
              answered by another label — and a print action that only exists
              at ordering means finding a doctor to raise the order again.
            */}
            <View style={s.top}>
              <Text style={s.accession}>{item.accession ?? '— no specimen no.'}</Text>
              {/*
                What is owed, and a way to take it.

                The person drawing the blood is standing in front of the
                patient — the only moment the money is easy to collect — and
                the row said an invoice existed without saying whether it was
                settled, which is the half that decides whether to ask.

                A link, never a gate: nothing in collection, dispatch or
                resulting reads it, and the tube is drawn either way.
              */}
              {item.invoice && item.invoice.settled && (
                <Text style={s.paidPill}>Paid</Text>
              )}

              {/*
                A button only for somebody who has the till.

                NURSE reads this screen for the send-out case — a clinic with no
                bench has no technician to draw the blood — and has no lab-till
                tab, so pressing this went nowhere. A refusal with no route out,
                on the screen added to close a refusal with no route out.

                They still see the amount, which is the useful half: they are in
                front of the patient and can say what is owed at the desk.
              */}
              {item.invoice && !item.invoice.settled && canTakePayment && (
                <Button
                  label={`Take payment · ${money(item.invoice.outstanding)}`}
                  variant="secondary"
                  onPress={() =>
                    router.push({
                      pathname: '/lab-till',
                      params: { invoice: String(item.invoice!.id) },
                    })
                  }
                />
              )}

              {item.invoice && !item.invoice.settled && !canTakePayment && (
                <Text style={s.duePill}>{money(item.invoice.outstanding)} due at the desk</Text>
              )}

              {/*
                Raise a charge that never got raised.

                Shown only where there is no invoice, so it is invisible on the
                ordinary case and present on exactly the orders that went out
                unbilled — the state nobody could get out of, because the price
                is captured at ordering and pricing the catalogue afterwards
                fixed the next order rather than this one.
              */}
              {item.invoiceId === null && (
                <Pressable
                  onPress={async () => {
                    setError(null);
                    try {
                      await api(`/lab-orders/${item.id}/charge`, { method: 'POST', body: {} });
                      await load();
                    } catch (e) {
                      setError(
                        e instanceof Error ? e.message : 'Could not raise that charge',
                      );
                    }
                  }}
                >
                  <Text style={s.raiseLink}>Raise charge</Text>
                </Pressable>
              )}

              {/*
                Always offered, even with no number yet — printing allocates
                one for an order raised before accessions existed. Hiding it
                for exactly those orders would make "no specimen no." permanent
                with no way out, which is what was reported.
              */}
              <Pressable
                onPress={async () => {
                  /*
                   * Caught here, because `shareDocument` throws and an
                   * unhandled rejection on a phone is a button that silently
                   * does nothing. The API's own sentence is the useful part —
                   * "that report has not been authorised yet" is an answer,
                   * and swallowing it leaves a technician pressing again.
                   */
                  try {
                    await shareDocument('specimen-labels', item.id);
                    // Refetched only on success: printing may have just
                    // allocated the specimen number.
                    if (!item.accession) await load();
                  } catch (e) {
                    setError(
                      e instanceof Error ? e.message : 'Could not print those labels',
                    );
                  }
                }}
              >
                <Text style={s.labelsLink}>
                  {item.accession ? 'Labels' : 'Get number & labels'}
                </Text>
              </Pressable>
            </View>
            <View style={s.top}>
              <Text style={s.name}>{item.patient.fullName}</Text>
              {item.priority !== 'ROUTINE' && (
                <Text style={[s.priority, item.priority === 'STAT' && s.stat]}>
                  {item.priority}
                </Text>
              )}
            </View>

            {/* Age and sex are on the card because reference ranges are banded
                by both — a technician checking a value needs them here, not one
                screen away. */}
            <Text style={s.muted}>
              {age(item.patient.dob)} · {item.patient.gender.toLowerCase()} · #{item.patient.id}
            </Text>
            <Text style={s.muted}>
              Requested {time(item.orderedAt)} by {item.requestedBy}
            </Text>

            {item.clinicalDetails ? (
              <Text style={s.clinical}>{item.clinicalDetails}</Text>
            ) : null}

            {item.rejectReason ? (
              <Text style={s.reject}>
                Previous sample rejected: {item.rejectReason}. Another one is needed.
              </Text>
            ) : null}

            {/*
              Work another hospital sent us, and whether they have the answer.

              Otherwise invisible from both ends: this laboratory sees an
              authorised report and the referring hospital sees an order still
              in progress, and neither screen mentions the other. Only rendered
              for referred work — `referredFrom` is null on our own orders,
              which is why it is a name and not a flag.
            */}
            {item.referredFrom && item.reportedBack === false && item.status === 'VERIFIED' ? (
              <Text style={s.notSent}>
                Not sent to {item.referredFrom}. Authorised here, and they do not have it.
              </Text>
            ) : null}

            {item.referredFrom && item.reportedBack === true ? (
              <Text style={s.muted}>
                Referred by {item.referredFrom} — the report has been sent back to them.
              </Text>
            ) : null}

            <View style={s.items}>
              {item.items.map((t) => (
                <Pressable
                  key={t.id}
                  disabled={item.status === 'ORDERED'}
                  onPress={() => router.push(`/lab-result/${t.id}`)}
                  style={s.itemRow}
                >
                  <Text style={s.itemCode}>{t.testCode}</Text>
                  <Text style={s.item}>{t.testName}</Text>
                  {t.hasCritical ? (
                    <Text style={s.critical}>
                      {t.criticalNotifiedAt ? 'critical · called' : 'critical · not called'}
                    </Text>
                  ) : t.resultedAt ? (
                    <Text style={s.done}>entered</Text>
                  ) : item.status !== 'ORDERED' ? (
                    <Text style={s.link}>enter</Text>
                  ) : null}
                </Pressable>
              ))}
            </View>

            <View style={s.actions}>
              {(item.status === 'ORDERED' || item.status === 'REJECTED') && (
                <Button
                  label={
                    item.items.every((t) => t.specimenType === 'NONE')
                      ? 'Patient attended'
                      : 'Sample taken'
                  }
                  onPress={() => void collect(item)}
                />
              )}
              {/*
                Hand the tube to the courier — only on a send-out, and only
                once it has been drawn. Marking a specimen sent before it
                exists tells the partner something is on its way when it is
                not, and they then wait for a van rather than ringing to ask.
              */}
              {item.destination === 'PARTNER' && !item.dispatchedAt && (
                <Button
                  label="Sent to the lab"
                  variant={item.status === 'ORDERED' ? 'secondary' : 'primary'}
                  disabled={item.status === 'ORDERED'}
                  onPress={() => void dispatchSpecimen(item)}
                />
              )}
              {item.status !== 'ORDERED' && item.status !== 'VERIFIED' && (
                <Button label="Sample unusable" variant="ghost" onPress={() => reject(item)} />
              )}
              {item.status === 'RESULTED' && (
                <Button label="Authorise report" onPress={() => verify(item)} />
              )}
              {/*
                The route out of a failed transmission, on exactly the rows
                where it applies. The server refuses once the other hospital has
                the report — a correction is a new order — but a button nobody
                should press is a button that eventually gets pressed.
              */}
              {item.referredFrom && item.reportedBack === false && item.status === 'VERIFIED' && (
                <Button label="Send report again" onPress={() => void reportBack(item)} />
              )}
            </View>
          </Card>
        )}
      />
    </Screen>
  );
}

function age(dob: string): string {
  const d = new Date(dob);
  const now = new Date();
  let years = now.getUTCFullYear() - d.getUTCFullYear();
  const m = now.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < d.getUTCDate())) years--;
  return `${years}y`;
}

const s = StyleSheet.create({
  segments: {
    flexDirection: 'row',
    gap: theme.space(1),
    paddingHorizontal: theme.space(3),
    paddingBottom: theme.space(2),
  },
  segment: {
    paddingHorizontal: theme.space(2),
    paddingVertical: theme.space(1),
    borderRadius: 999,
    borderWidth: 1,
    borderColor: theme.color.border,
  },
  segmentOn: { borderColor: theme.color.primary, backgroundColor: theme.color.primarySoft },
  segmentText: { ...theme.font.caption, color: theme.color.textMuted },
  segmentTextOn: { color: theme.color.primary, fontWeight: '600' },
  list: { padding: theme.space(3), gap: theme.space(2), paddingBottom: theme.space(10) },
  card: { gap: theme.space(0.5) },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  /* The row a scan just landed on, so the eye goes straight to it in a
     list of forty. */
  cardScanned: { borderColor: theme.color.primary, borderWidth: 2 },
  scanRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space(2),
    paddingHorizontal: theme.space(4),
    paddingTop: theme.space(3),
  },
  scanInput: {
    ...theme.font.body,
    flex: 1,
    fontFamily: 'monospace',
    color: theme.color.text,
    borderWidth: 1,
    borderColor: theme.color.border,
    borderRadius: theme.radius.md,
    paddingHorizontal: theme.space(3),
    paddingVertical: theme.space(2),
    backgroundColor: theme.color.surface,
  },
  accession: {
    ...theme.font.caption,
    fontFamily: 'monospace',
    fontWeight: '700',
    color: theme.color.primary,
    flex: 1,
  },
  /* The amount, for a role that cannot open the till. Warning rather than a
     button, because it is information and not an action. */
  duePill: {
    ...theme.font.caption,
    fontWeight: '700',
    color: theme.color.warning,
    alignSelf: 'center',
  },
  paidPill: {
    ...theme.font.caption,
    fontWeight: '700',
    color: theme.color.success,
    alignSelf: 'center',
  },
  raiseLink: {
    ...theme.font.caption,
    color: theme.color.warning,
    fontWeight: '700',
    textDecorationLine: 'underline',
  },
  labelsLink: { ...theme.font.caption, color: theme.color.textMuted, textDecorationLine: 'underline' },
  name: { ...theme.font.body, fontWeight: '700', color: theme.color.text },
  priority: {
    ...theme.font.caption,
    fontWeight: '700',
    color: theme.color.warning,
    textTransform: 'uppercase',
  },
  stat: { color: theme.color.danger },
  muted: { ...theme.font.caption, color: theme.color.textMuted },
  clinical: { ...theme.font.caption, color: theme.color.text, marginTop: theme.space(1) },
  reject: { ...theme.font.caption, color: theme.color.warning, marginTop: theme.space(1) },
  /* Danger rather than warning: a report the other hospital does not have is a
     patient waiting, not an inconvenience. */
  notSent: {
    ...theme.font.caption,
    color: theme.color.danger,
    fontWeight: '700',
    marginTop: theme.space(1),
  },
  items: { marginTop: theme.space(1.5), gap: theme.space(0.5) },
  itemRow: { flexDirection: 'row', alignItems: 'center', gap: theme.space(1) },
  itemCode: {
    ...theme.font.caption,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
    color: theme.color.textMuted,
    width: 56,
  },
  item: { ...theme.font.caption, color: theme.color.text, flex: 1 },
  link: { ...theme.font.caption, color: theme.color.primary, fontWeight: '600' },
  done: { ...theme.font.caption, color: theme.color.textSubtle },
  critical: { ...theme.font.caption, color: theme.color.danger, fontWeight: '700' },
  actions: { flexDirection: 'row', gap: theme.space(1), marginTop: theme.space(2) },
  empty: {
    ...theme.font.caption,
    color: theme.color.textSubtle,
    textAlign: 'center',
    padding: theme.space(6),
    lineHeight: 18,
  },
});
