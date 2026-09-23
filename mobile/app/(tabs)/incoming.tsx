import { useCallback, useState } from 'react';
import { Alert, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { api } from '@/lib/api';
import { useLiveData } from '@/lib/use-live-data';
import { theme } from '@/lib/theme';
import { date, relativeAge } from '@/lib/format';
import { AppHeader, Card, ErrorBanner, Screen } from '@/components/ui';
import type { PrescriptionReferral } from '@/lib/types';

/**
 * Prescriptions written at another hospital and sent to this pharmacy.
 *
 * WHAT THESE ARE, AND ARE NOT
 * ---------------------------
 * Copies transmitted into this tenant, owned here and protected by this
 * hospital's own policy like any other row. Not a window into another
 * hospital's records: there is no link back, this pharmacy cannot read that
 * patient's history, and it is not supposed to be able to.
 *
 * WHY THE ALLERGY LINE IS ON EVERY CARD
 * -------------------------------------
 * The sending hospital does not transmit allergies — minimum-necessary applies
 * at least as strongly across a company boundary as across a role one. The
 * consequence is that **no allergy check ran at all**, and a pharmacist who
 * reads an empty warning area as "nothing found" would be wrong in the most
 * dangerous available direction. So it is stated on every card rather than
 * mentioned once in a help screen.
 */
type Segment = 'waiting' | 'dispensed' | 'declined';
const SEGMENTS: Segment[] = ['waiting', 'dispensed', 'declined'];

export default function IncomingScreen() {
  const [rows, setRows] = useState<PrescriptionReferral[] | null>(null);
  /*
   * The list was waiting-only, so a referral vanished the moment it was
   * handed over and there was nowhere to answer "what did the other hospital
   * send us, and what happened to it". Same omission as the pharmacy invoice
   * list, which hid every settled invoice.
   */
  const [segment, setSegment] = useState<Segment>('waiting');
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [fetchedAt, setFetchedAt] = useState<Date | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api<{ data: PrescriptionReferral[] }>(
        `/pharmacy/referrals?status=${segment}`,
      );
      setRows(res.data);
      setFetchedAt(new Date());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load incoming prescriptions');
    }
  }, [segment]);

  useLiveData(load);

  const decline = (referral: PrescriptionReferral) => {
    Alert.prompt?.(
      'Decline',
      `Why is ${referral.reference} being declined? The sending hospital cannot ask.`,
      async (reason?: string) => {
        if (!reason || reason.trim().length < 6) return;
        try {
          await api(`/pharmacy/referrals/${referral.id}/decline`, {
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
            : // Says which tab it is counting. "3 waiting" over a list of
              // declined referrals is a wrong number stated confidently.
              `${rows.length} ${segment} · ${relativeAge(fetchedAt)}`
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
              {seg === 'waiting' ? 'Waiting' : seg === 'dispensed' ? 'Dispensed' : 'Declined'}
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
          // "Loading" and "nothing waiting" look identical as an empty list and
          // mean opposite things.
          <Text style={s.empty}>
            {rows === null
              ? 'Loading…'
              : segment === 'waiting'
                ? 'Nothing waiting. Prescriptions sent here by partner hospitals appear in this list.'
                : 'Nothing here yet. Referrals move to this tab once they have been handled.'}
          </Text>
        }
        renderItem={({ item }) => (
          <Card style={s.card}>
            <View style={s.top}>
              <Text style={s.reference}>{item.reference}</Text>
              <Text style={s.muted}>{date(item.issuedAt)}</Text>
            </View>

            <Text style={s.name}>{item.patientName}</Text>
            <Text style={s.muted}>
              {item.from}
              {item.patientDob ? ` · born ${date(item.patientDob)}` : ''}
            </Text>
            <Text style={s.muted}>
              Prescribed by {item.prescriberName}
              {item.prescriberRegistrationNo ? ` (${item.prescriberRegistrationNo})` : ''}
            </Text>

            {/*
              The line as written, then what it comes to.

              "500mg · 2 · 7" made the pharmacist work out that "2" meant
              twice a day and then multiply. Mental arithmetic at a counter is
              where dispensing errors come from. The doctor's own text stays
              above the total rather than being replaced by it — the
              prescription is what was written, this is a reading of it, and
              both have to be visible to catch a misreading.
            */}
            <View style={s.items}>
              {item.items.map((i, n) => (
                <View key={n} style={s.itemBlock}>
                  <Text style={s.item}>
                    <Text style={s.itemName}>{i.medicineName}</Text> — {i.dosage}, {i.frequency},{' '}
                    {i.duration}
                  </Text>
                  <Text style={s.itemPlain}>
                    {i.dosage}, {i.frequencyLabel}
                    {i.durationLabel ? ` for ${i.durationLabel}` : ''}
                  </Text>
                  {i.totalUnits ? (
                    <Text style={s.itemTotal}>
                      Dispense {i.totalUnits.amount} {i.totalUnits.unit}
                    </Text>
                  ) : i.totalDoses ? (
                    <Text style={s.itemTotal}>{i.totalDoses} doses</Text>
                  ) : (
                    /* Stated, never blank: a missing total and a withheld one
                       look identical and mean opposite things. */
                    <Text style={s.itemUnknown}>Quantity not calculated</Text>
                  )}
                  {(i.interpretation || i.whyNot) && (
                    <Text style={s.itemNote}>
                      {[i.interpretation, i.whyNot].filter(Boolean).join(' · ')}
                    </Text>
                  )}
                </View>
              ))}
            </View>

            <View style={s.warn}>
              <Text style={s.warnText}>
                No allergy check was run. Allergies are not sent between hospitals — ask the
                patient before dispensing.
              </Text>
            </View>

            {/* The outcome, on the card. Without it a history tab is just an
                older copy of the queue. */}
            {item.dispensedAt && (
              <Text style={s.outcomeOk}>Dispensed {date(item.dispensedAt)} at this counter.</Text>
            )}
            {item.declinedAt && (
              <Text style={s.outcomeNo}>
                Declined {date(item.declinedAt)}
                {item.declineReason ? ` — ${item.declineReason}` : ''}
              </Text>
            )}

            <View style={s.actions}>
              {/* Dispensed through the counter sale: the prescription belongs
                  to another hospital, so there is no local row to key on and
                  the pharmacist maps the names onto their own stock. */}
              {/* Only while it is open: a Dispense button on a referral that
                  is already filled invites handing the same medicine over
                  twice, and the server's refusal should not be how anybody
                  first learns that. */}
              {segment === 'waiting' && (
                <>
                  <Pressable
                    onPress={() => router.push(`/sell?referral=${item.id}`)}
                    style={s.primary}
                  >
                    <Text style={s.primaryText}>Dispense</Text>
                  </Pressable>
                  <Pressable onPress={() => decline(item)} style={s.secondary}>
                    <Text style={s.secondaryText}>Decline</Text>
                  </Pressable>
                </>
              )}
            </View>
          </Card>
        )}
      />
    </Screen>
  );
}

const s = StyleSheet.create({
  list: { padding: theme.space(3), gap: theme.space(2) },
  card: { gap: theme.space(1) },
  top: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  reference: {
    ...theme.font.title,
    color: theme.color.primary,
    letterSpacing: 2,
    fontVariant: ['tabular-nums'],
  },
  name: { ...theme.font.heading, color: theme.color.text },
  muted: { ...theme.font.caption, color: theme.color.textSubtle, lineHeight: 16 },
  empty: {
    ...theme.font.caption,
    color: theme.color.textSubtle,
    textAlign: 'center',
    marginTop: theme.space(6),
    lineHeight: 18,
  },

  items: { marginTop: theme.space(1), gap: 2 },
  item: { ...theme.font.small, color: theme.color.textMuted, lineHeight: 18 },
  itemName: { color: theme.color.text, fontWeight: '600' },
  segments: { flexDirection: 'row', gap: 8, paddingHorizontal: theme.space(3), paddingBottom: theme.space(1) },
  segment: {
    borderWidth: 1,
    borderColor: theme.color.border,
    borderRadius: theme.radius.sm,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  segmentOn: { borderColor: theme.color.primary, backgroundColor: theme.color.primarySoft },
  segmentText: { ...theme.font.caption, color: theme.color.textMuted },
  segmentTextOn: { color: theme.color.primary, fontWeight: '600' },
  outcomeOk: { ...theme.font.caption, color: theme.color.success },
  outcomeNo: { ...theme.font.caption, color: theme.color.danger },
  itemBlock: { marginBottom: 8 },
  /* The plain-English reading, and the count. Weighted so the eye lands on
     the number that gets counted out. */
  itemPlain: { ...theme.font.caption, color: theme.color.text },
  itemTotal: { ...theme.font.caption, color: theme.color.primary, fontWeight: '700' },
  itemUnknown: { ...theme.font.caption, color: theme.color.warning, fontWeight: '600' },
  itemNote: { ...theme.font.caption, color: theme.color.textSubtle },

  warn: {
    marginTop: theme.space(1),
    borderRadius: theme.radius.sm,
    backgroundColor: theme.color.warningSoft,
    padding: theme.space(2),
  },
  warnText: { ...theme.font.caption, color: theme.color.warning, lineHeight: 16 },

  actions: { flexDirection: 'row', gap: theme.space(2), marginTop: theme.space(2) },
  primary: {
    flex: 1,
    borderRadius: theme.radius.sm,
    backgroundColor: theme.color.primary,
    paddingVertical: theme.space(2),
    alignItems: 'center',
  },
  primaryText: { ...theme.font.body, color: '#fff', fontWeight: '700' },
  secondary: {
    borderRadius: theme.radius.sm,
    borderWidth: 1,
    borderColor: theme.color.border,
    paddingVertical: theme.space(2),
    paddingHorizontal: theme.space(3),
    alignItems: 'center',
  },
  secondaryText: { ...theme.font.body, color: theme.color.textMuted },
});
