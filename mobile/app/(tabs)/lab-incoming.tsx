import { useCallback, useState } from 'react';
import { Alert, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { router } from 'expo-router';
import { api } from '@/lib/api';
import { useLiveData } from '@/lib/use-live-data';
import { theme } from '@/lib/theme';
import { date, relativeAge } from '@/lib/format';
import { BILLING_LABEL_INBOUND } from '@/lib/referral-billing';
import { AppHeader, Button, Card, ErrorBanner, Screen } from '@/components/ui';
import type { LabReferral, LabTest } from '@/lib/types';
import { MapTestsSheet } from '@/components/map-tests-sheet';

/**
 * Tests another hospital has sent to this laboratory.
 *
 * WHAT MAKES THESE DIFFERENT FROM AN INCOMING PRESCRIPTION
 * --------------------------------------------------------
 * A prescription referral ends at this counter — the medicine is handed over
 * and the sending hospital never hears again. A lab referral cannot end here,
 * because the result is the thing they asked for. Reporting one writes it back
 * into their records, against the order their doctor raised.
 *
 * That write is the only place in this system where one hospital puts data into
 * another's, and it is narrow on purpose: every test on the referral at once,
 * once only, and refused outright if they have already reported it themselves.
 *
 * REPORTING IS ON THE DESK, DELIBERATELY
 * --------------------------------------
 * A referral report is several tests, each with values and a narrative, going
 * to another company under a named pathologist's authorisation. That is a
 * sit-down job, and this is one of the few places where "the phone is for
 * looking" is a real argument rather than a story about where work happens. The
 * phone can see the queue and decline — which is the time-critical half, since
 * a hospital waiting on a sample that will never be run is the failure this
 * exists to prevent.
 */
type Segment = 'waiting' | 'resulted' | 'declined';
const SEGMENTS: Segment[] = ['waiting', 'resulted', 'declined'];

export default function LabIncomingScreen() {
  /*
   * Reporting a partner's result, which this screen could not do.
   *
   * It offered Decline and a note saying the other half lived on the web — a
   * plausible story standing in for nobody having built it, which is the shape
   * that has caught this project four times now. A standalone laboratory whose
   * only action is refusal has a queue that looks like it works.
   */
  const [busyId, setBusyId] = useState<number | null>(null);
  const [mapping, setMapping] = useState<LabReferral | null>(null);
  const [catalogue, setCatalogue] = useState<LabTest[]>([]);

  /**
   * Take the work on.
   *
   * The server raises a real `LabOrder` for it, maps the sender's test codes
   * onto this laboratory's catalogue, and registers the referred patient —
   * flagged, so they stay out of reception's search. A code this lab does not
   * offer is refused by name rather than skipped, because the answer is either
   * to add it or to decline, and both are decisions a person makes.
   */
  async function accept(referral: LabReferral) {
    setBusyId(referral.id);
    try {
      const res = await api<{ invoiceId: number | null; unpriced: string[] }>(
        `/lab/referrals/${referral.id}/accept`,
        { method: 'POST', body: {} },
      );
      await load();

      /*
       * The patient pays here, and has not arrived yet.
       *
       * Under PATIENT_PAYS the money is taken when they walk in to give the
       * sample, which is at collection rather than now. Opening the till would
       * put a payment form in front of a technician for somebody who is not in
       * the building, and drop them out of the queue they were working.
       *
       * Said rather than left silent: the invoice exists, and an invoice
       * nobody was told about is one nobody collects.
       */
      if (referral.billing === 'PATIENT_PAYS' && res.invoiceId && !res.unpriced.length) {
        Alert.alert(
          'Accepted',
          `${referral.reference} is on your worklist, and ${referral.patientName} pays here.\n\nTake the payment when they come in to give the sample — the invoice is waiting on the till.`,
          [
            { text: 'Got it', style: 'cancel' },
            /*
             * Offered, never forced. They might be standing here already, and
             * a shortcut to the next task must not become a condition on the
             * last one — nothing about resulting checks whether it was paid.
             */
            {
              text: 'Take payment now',
              onPress: () =>
                router.replace({
                  pathname: '/lab-till',
                  params: { invoice: String(res.invoiceId) },
                }),
            },
          ],
        );
        return;
      }

      /*
       * Hand straight over to payment, exactly as dispensing does.
       *
       * Under ORIGIN_PAYS the debtor is the referring hospital: nobody is
       * standing at the counter, the charge was raised a second ago, and an
       * invoice that appears silently in a list is one nobody is sure was
       * raised — reported as "it is silently generating the invoice, people may
       * not know we need to take the money".
       */
      if (res.invoiceId && !res.unpriced.length) {
        /*
         * The object form, and `replace` rather than `push`.
         *
         * A tab route given as a plain string with a query — `/lab-till?x=1` —
         * does not match, and expo-router silently falls back to the first tab,
         * which for a technician is the worklist. Reported as "it redirects to
         * the queue instead of the invoice". `dispense/[id]` already navigates
         * this way and works; this now matches it exactly.
         *
         * `replace`, because going back to a referral that has just been
         * accepted would offer an Accept button the server would refuse.
         */
        router.replace({
          pathname: '/lab-till',
          params: { invoice: String(res.invoiceId) },
        });
        return;
      }

      /*
       * Except when something was left unpriced. Then stay put and name it —
       * that notice is the one thing on this screen the technician can still
       * act on, and opening a payment form on top of it buries it. The same
       * rule the dispensing sheet follows.
       */
      /*
       * A charge was raised but something was also left unpriced.
       *
       * Both facts matter and only one of them can be the destination, so the
       * unpriced warning is the message and taking the payment is a button on
       * it. Silently jumping to the till would bury the number nobody else will
       * notice; refusing to offer the jump would leave money uncollected for
       * the tests that *were* priced.
       */
      Alert.alert(
        'Accepted',
        [
          `${referral.reference} is on your worklist. Collect the specimen, run it, then authorise — the result goes back to ${referral.from} when you do.`,
          res.unpriced.length
            ? `Not charged for: ${res.unpriced.join(', ')} — price them in the catalogue, then raise the charge.`
            : 'No charge was raised — the tests have no price set.',
        ].join('\n\n'),
        res.invoiceId
          ? [
              { text: 'Later', style: 'cancel' },
              {
                text: 'Take payment',
                onPress: () =>
                  router.replace({
                    pathname: '/lab-till',
                    params: { invoice: String(res.invoiceId) },
                  }),
              },
            ]
          : undefined,
      );
    } catch (e) {
      /*
       * An unmapped test is a question, not a dead end.
       *
       * Codes are local vocabulary — one hospital's FBC is another's CBC — and
       * the old refusal told the technician to add the test to the catalogue,
       * which is an administrator's job. So the answer is a picker rather than
       * an apology.
       */
      if (e instanceof Error && /which of your tests/i.test(e.message)) {
        const tests = await api<{ data: LabTest[] }>('/lab-tests').catch(() => ({ data: [] }));
        setCatalogue(tests.data);
        setMapping(referral);
      } else {
        Alert.alert('Could not accept', e instanceof Error ? e.message : 'Please try again.');
      }
    } finally {
      setBusyId(null);
    }
  }

  /** Accept again, saying which of our tests each referred one is. */
  async function acceptMapped(referral: LabReferral, chosen: Record<number, number>) {
    setBusyId(referral.id);
    try {
      await api(`/lab/referrals/${referral.id}/accept`, {
        method: 'POST',
        body: {
          mappings: Object.entries(chosen).map(([referralItemId, labTestId]) => ({
            referralItemId: Number(referralItemId),
            labTestId,
          })),
        },
      });
      setMapping(null);
      await load();
    } catch (e) {
      Alert.alert('Could not accept', e instanceof Error ? e.message : 'Please try again.');
    } finally {
      setBusyId(null);
    }
  }
  const [segment, setSegment] = useState<Segment>('waiting');
  const [rows, setRows] = useState<LabReferral[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [fetchedAt, setFetchedAt] = useState<Date | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api<{ data: LabReferral[] }>(`/lab/referrals?status=${segment}`);
      setRows(res.data);
      setFetchedAt(new Date());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load incoming work');
    }
  }, [segment]);

  useLiveData(load);

  const decline = (referral: LabReferral) => {
    Alert.prompt?.(
      'Decline',
      `Why is ${referral.reference} being declined? ${referral.from} sees this on their own order, and it lands as “another sample is needed” rather than as a cancellation.`,
      async (reason?: string) => {
        if (!reason || reason.trim().length < 6) return;
        try {
          await api(`/lab/referrals/${referral.id}/decline`, {
            method: 'POST',
            body: { reason: reason.trim() },
          });
          await load();
        } catch (e) {
          setError(e instanceof Error ? e.message : 'Could not decline that');
        }
      },
    );
  };

  return (
    <Screen>
      <AppHeader
        title="Incoming"
        subtitle={
          rows === null
            ? `Updated ${relativeAge(fetchedAt)}`
            : `${rows.length} ${segment} · ${relativeAge(fetchedAt)}`
        }
      />

      <View style={s.segments}>
        {SEGMENTS.map((seg) => (
          <Pressable
            key={seg}
            onPress={() => setSegment(seg)}
            style={[s.segment, segment === seg && s.segmentOn]}
          >
            <Text style={[s.segmentText, segment === seg && s.segmentTextOn]}>
              {seg === 'waiting' ? 'Waiting' : seg === 'resulted' ? 'Reported' : 'Declined'}
            </Text>
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
          <Text style={s.empty}>
            {rows === null
              ? 'Loading…'
              : segment === 'waiting'
                ? 'Nothing waiting. Work arrives here when a hospital that has your code sends a test — and only once an administrator has switched on “accept orders from other hospitals”.'
                : 'Nothing on this tab.'}
          </Text>
        }
        renderItem={({ item }) => (
          <Card style={s.card}>
            <View style={s.top}>
              <Text style={s.reference}>{item.reference}</Text>
              {item.priority !== 'ROUTINE' && (
                <Text style={[s.priority, item.priority === 'STAT' && s.stat]}>{item.priority}</Text>
              )}
            </View>

            <Text style={s.name}>{item.patientName}</Text>
            {/*
              Who owes for it, before the technician takes it on.

              Not decoration: it decides what happens next on this screen. An
              institutional debt is recorded now and chased later; the
              patient's is collected when they walk in with their arm out, and
              reading it after accepting is too late — the redirect has already
              happened.
            */}
            <Text style={item.billing === 'PATIENT_PAYS' ? s.payerPatient : s.muted}>
              {BILLING_LABEL_INBOUND[item.billing]}
            </Text>
            {/*
              Their order number, quoted back. A send-out with two identifiers
              and no mapping between them is how a telephone call about a tube
              becomes twenty minutes of searching.
            */}
            {item.sourceAccession ? (
              <Text style={s.muted}>their ref {item.sourceAccession}</Text>
            ) : null}
            {/*
              Whether the tube exists yet, and how old it is.

              A send-out is drawn at the referring hospital and couriered — the
              patient was never here. A referral with no draw time is one whose
              specimen has not been taken, transmitted so this laboratory can
              expect the work; showing nothing makes that indistinguishable
              from a sample that has gone missing.
            */}
            <Text style={item.collectedAt ? s.muted : s.payerPatient}>
              {item.collectedAt
                ? `drawn ${date(item.collectedAt)}${
                    item.dispatchedAt ? ` · sent ${date(item.dispatchedAt)}` : ' · not yet sent'
                  }`
                : 'specimen not yet taken'}
            </Text>
            <Text style={s.muted}>
              {item.from}
              {item.patientDob ? ` · born ${date(item.patientDob)}` : ''}
            </Text>
            <Text style={s.muted}>Requested by {item.requestedByName}</Text>

            {item.clinicalDetails ? (
              <Text style={s.clinical}>{item.clinicalDetails}</Text>
            ) : null}

            <View style={s.items}>
              {item.items.map((t) => (
                <Text key={t.id} style={s.item}>
                  <Text style={s.itemCode}>{t.testCode}</Text> {t.testName}
                </Text>
              ))}
            </View>

            {/* The outcome is rendered from the row rather than inferred from
                which tab returned it. */}
            {item.declinedAt ? (
              <Text style={s.outcome}>Declined — {item.declineReason}</Text>
            ) : null}
            {item.resultedAt ? (
              <Text style={s.outcome}>Reported back to {item.from}.</Text>
            ) : null}

            {/* Actions only while it is still waiting. A Report button beside
                a row reported last week is a trap — the same rule the web
                referrals screen states. */}
            {/*
              Accepted work is on the worklist, not here.

              Reporting used to happen straight from this queue — values typed
              into a form and transmitted — which skipped specimen acceptance,
              the bench and authorisation. Accepting raises this laboratory's
              own order, and from there referred work runs the identical
              collect → bench → result → authorise flow as local work, with the
              result transmitted back when it is authorised.
            */}
            {item.acceptedAt && !item.resultedAt && !item.declinedAt ? (
              <Text style={s.outcome}>On the worklist — accepted {date(item.acceptedAt)}.</Text>
            ) : null}

            {!item.acceptedAt && !item.resultedAt && !item.declinedAt && (
              <View style={s.actions}>
                <Button label="Accept" busy={busyId === item.id} onPress={() => accept(item)} />
                <Button label="Decline" variant="ghost" onPress={() => decline(item)} />
              </View>
            )}
          </Card>
        )}
      />
      <MapTestsSheet
        referral={mapping}
        catalogue={catalogue}
        busy={mapping ? busyId === mapping.id : false}
        onClose={() => setMapping(null)}
        onAccept={(chosen) => mapping && void acceptMapped(mapping, chosen)}
      />
    </Screen>
  );
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
  reference: {
    ...theme.font.title,
    color: theme.color.primary,
    letterSpacing: 2,
  },
  priority: {
    ...theme.font.caption,
    fontWeight: '700',
    color: theme.color.warning,
    textTransform: 'uppercase',
  },
  stat: { color: theme.color.danger },
  name: { ...theme.font.bodyStrong, color: theme.color.text },
  payerPatient: {
    ...theme.font.caption,
    color: theme.color.primary,
    fontWeight: '700',
  },
  muted: { ...theme.font.caption, color: theme.color.textMuted },
  clinical: { ...theme.font.caption, color: theme.color.text, marginTop: theme.space(1) },
  items: { marginTop: theme.space(1.5), gap: theme.space(0.5) },
  item: { ...theme.font.caption, color: theme.color.text },
  itemCode: { color: theme.color.textMuted },
  outcome: { ...theme.font.caption, color: theme.color.textMuted, marginTop: theme.space(1.5) },
  actions: { marginTop: theme.space(2), gap: theme.space(1) },
  note: { ...theme.font.caption, color: theme.color.textSubtle, lineHeight: 16 },
  empty: {
    ...theme.font.caption,
    color: theme.color.textSubtle,
    textAlign: 'center',
    padding: theme.space(6),
    lineHeight: 18,
  },
});
