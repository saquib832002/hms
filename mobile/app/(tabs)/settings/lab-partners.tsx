import { useCallback, useState } from 'react';
import { Alert, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { useLiveData } from '@/lib/use-live-data';
import { theme } from '@/lib/theme';
import { date } from '@/lib/format';
import {
  AppHeader,
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  Field,
  Screen,
} from '@/components/ui';
import type { LabPartner, ReferralBilling } from '@/lib/types';
import {
  BILLING_HINT,
  BILLING_LABEL,
  BILLING_MODES,
  lapsedReason,
  unavailableReason,
} from '@/lib/referral-billing';

/**
 * Laboratories this hospital may send work to.
 *
 * WHY THE HANDSHAKE IS TWO-SIDED, AND WHY THIS SCREEN SAYS SO
 * -----------------------------------------------------------
 * Adding a partner needs *their* code, and it only works if they have switched
 * on "accept work from other hospitals" at their end. Neither half does
 * anything alone, which is correct and was invisible: an administrator who had
 * done their side saw a flat refusal with no way to tell which half was
 * missing.
 *
 * So the refusal is deliberately one message — "no such code", "they run no
 * lab" and "they have not opted in" are indistinguishable on purpose, for the
 * same reason login does not separate "no such account" from "wrong password".
 * A dropdown of every hospital running a laboratory would turn the vendor's
 * customer base into something any administrator can read.
 *
 * This hospital's own code is on Clinic settings, unconditionally — the other
 * side needs it, and nobody can decide whether to hand it out without seeing
 * what it is.
 *
 * REMOVING IS A SOFT DELETE, AND HAS TO BE
 * ----------------------------------------
 * Orders already sent carry `routedToTenantId`, and "where did this go" is
 * asked precisely when a partnership has ended. Re-adding a removed partner
 * reactivates the original row rather than colliding with it.
 */
export default function LabPartnersScreen() {
  const { user } = useAuth();
  const [rows, setRows] = useState<LabPartner[] | null>(null);
  const [slug, setSlug] = useState('');
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  /*
   * Defaults to the arrangement every partnership predating this had, so
   * somebody who does not think about it gets what they already have rather
   * than a surprise on the first invoice.
   */
  const [billing, setBilling] = useState<ReferralBilling>('ORIGIN_PAYS');
  const [savingId, setSavingId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api<{ data: LabPartner[] }>('/lab-partners');
      setRows(res.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load partner labs');
    }
  }, []);

  useLiveData(load);

  async function add() {
    setBusy(true);
    setError(null);
    try {
      await api('/lab-partners', {
        method: 'POST',
        body: { slug: slug.trim().toLowerCase(), label: label.trim(), billing },
      });
      setSlug('');
      setLabel('');
      setBilling('ORIGIN_PAYS');
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not add that laboratory');
    } finally {
      setBusy(false);
    }
  }

  /**
   * Change how a partnership is billed.
   *
   * On the phone deliberately, on the same line as a doctor's consultation fee
   * and the clinic's currency: one field, one tap, and it blocks somebody
   * else's work while it is wrong — a doctor cannot send a test through a
   * partnership set up on terms the other lab has withdrawn, and the person who
   * can fix that is usually the owner, holding a phone.
   *
   * The server re-checks against the other laboratory, so a mode they have
   * since stopped accepting is refused here with their reason rather than
   * saved and met by a doctor mid-consultation.
   */
  async function setBillingFor(partner: LabPartner, mode: ReferralBilling) {
    if (mode === partner.billing) return;

    const why = unavailableReason(mode, partner.accepts, partner.label);
    if (why) {
      // Named rather than silently ignored. The missing half is a switch at the
      // other hospital, which nobody on this screen can see or reach.
      Alert.alert('They do not take work that way', why);
      return;
    }

    setSavingId(partner.id);
    setError(null);
    try {
      await api(`/lab-partners/${partner.id}`, { method: 'PATCH', body: { billing: mode } });
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not change how that partner is billed');
    } finally {
      setSavingId(null);
    }
  }

  function remove(partner: LabPartner) {
    Alert.alert(
      `Remove ${partner.label}?`,
      'Work already sent to them keeps its record and stays traceable. You can add them again later.',
      [
        { text: 'Keep', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            try {
              await api(`/lab-partners/${partner.id}`, { method: 'DELETE' });
              await load();
            } catch (e) {
              Alert.alert('Could not remove', e instanceof Error ? e.message : 'Please try again.');
            }
          },
        },
      ],
    );
  }

  return (
    <Screen>
      <AppHeader
        title="Partner labs"
        subtitle={rows === null ? 'Loading…' : `${rows.length} partners`}
      />

      <View style={s.form}>
        {/* Their code, not a picker. The directory is deliberately not
            browsable — see the note above. */}
        <Field
          label="Their code"
          value={slug}
          onChange={setSlug}
          placeholder="the code they gave you"
          autoCapitalize="none"
        />
        <Field
          label="Call them"
          value={label}
          onChange={setLabel}
          placeholder="e.g. Riverside Diagnostics"
          autoCapitalize="words"
        />
        {/*
          Who pays, chosen while the partnership is created.

          It has to be known before a doctor orders through it, because that is
          when this hospital decides whether to charge the patient — and a
          default nobody looked at is how a clinic ends up doing referred work
          for nothing.
        */}
        <Text style={s.pickerLabel}>Who pays them</Text>
        {BILLING_MODES.map((m) => (
          <Pressable key={m} onPress={() => setBilling(m)} style={s.choice}>
            <Text style={billing === m ? s.radioOn : s.radioOff}>{billing === m ? '●' : '○'}</Text>
            <View style={s.grow}>
              <Text style={s.choiceLabel}>{BILLING_LABEL[m]}</Text>
              <Text style={s.muted}>{BILLING_HINT[m]}</Text>
            </View>
          </Pressable>
        ))}

        <Button
          label="Add partner"
          busy={busy}
          disabled={!slug.trim() || !label.trim()}
          onPress={() => void add()}
        />
        <Text style={s.hint}>
          Your own code is {user?.hospital?.slug ?? '—'} — give it to them so they can send work
          here. They also have to switch on accepting outside work at their end.
        </Text>
      </View>

      {error && <ErrorBanner message={error} />}

      <FlatList
        data={rows ?? []}
        keyExtractor={(p) => String(p.id)}
        contentContainerStyle={s.list}
        keyboardShouldPersistTaps="handled"
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
          rows === null ? null : (
            <EmptyState
              glyph="⇆"
              title="No partner labs"
              body="Add one with the code they gave you, then doctors can send tests there."
            />
          )
        }
        renderItem={({ item }) => (
          <Card>
            <View style={s.row}>
              <View style={s.grow}>
                <Text style={s.name}>{item.label}</Text>
                <Text style={s.muted}>Added {date(item.createdAt)}</Text>
              </View>
              <Button label="Remove" variant="ghost" onPress={() => remove(item)} />
            </View>

            {/*
              A partnership the other end has changed under us. Named here,
              where somebody can act on it, rather than left to surface as a
              refusal in front of a patient.
            */}
            {item.lapsed && <Text style={s.warn}>{lapsedReason(item.lapsed, item.label)}</Text>}

            <View style={s.modes}>
              {BILLING_MODES.map((m) => {
                const on = item.billing === m;
                /*
                 * Offered and refused with a reason rather than hidden. An
                 * option that is simply absent is indistinguishable from a
                 * feature that does not exist, and nobody here can otherwise
                 * discover that the missing half is a switch at the other
                 * hospital.
                 */
                const off = unavailableReason(m, item.accepts, item.label) !== null;
                return (
                  <Pressable
                    key={m}
                    disabled={savingId === item.id}
                    onPress={() => void setBillingFor(item, m)}
                    style={[s.chip, on && s.chipOn, off && !on && s.chipOff]}
                  >
                    <Text style={on ? s.chipTextOn : s.chipText}>{BILLING_LABEL[m]}</Text>
                  </Pressable>
                );
              })}
            </View>
          </Card>
        )}
      />
    </Screen>
  );
}

const s = StyleSheet.create({
  form: { padding: theme.space(4), paddingBottom: 0, gap: theme.space(2) },
  hint: { ...theme.font.caption, color: theme.color.textSubtle },
  list: { padding: theme.space(4), gap: theme.space(3) },
  row: { flexDirection: 'row', alignItems: 'center', gap: theme.space(2) },
  grow: { flex: 1 },
  name: { ...theme.font.body, fontWeight: '700', color: theme.color.text },
  muted: { ...theme.font.caption, color: theme.color.textMuted },
  warn: { ...theme.font.caption, color: theme.color.warning, marginTop: theme.space(1) },
  pickerLabel: {
    ...theme.font.caption,
    color: theme.color.textMuted,
    fontWeight: '700',
    marginTop: theme.space(1),
  },
  choice: { flexDirection: 'row', alignItems: 'flex-start', gap: theme.space(2) },
  choiceLabel: { ...theme.font.body, color: theme.color.text },
  radioOn: { ...theme.font.body, color: theme.color.primary },
  radioOff: { ...theme.font.body, color: theme.color.textSubtle },
  modes: { flexDirection: 'row', gap: theme.space(2), marginTop: theme.space(2) },
  chip: {
    paddingHorizontal: theme.space(3),
    paddingVertical: theme.space(1),
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.color.border,
  },
  chipOn: { backgroundColor: theme.color.primary, borderColor: theme.color.primary },
  chipOff: { opacity: 0.4 },
  chipText: { ...theme.font.caption, color: theme.color.textMuted },
  chipTextOn: { ...theme.font.caption, color: theme.color.surface, fontWeight: '700' },
});
