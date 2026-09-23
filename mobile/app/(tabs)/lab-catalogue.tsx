import { useCallback, useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, Text, TextInput, View } from 'react-native';
import { api, ApiError } from '@/lib/api';
import { useLiveData } from '@/lib/use-live-data';
import { theme } from '@/lib/theme';
import { useMoney } from '@/lib/use-money';
import {
  AppHeader,
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  Field,
  Screen,
} from '@/components/ui';
import type { LabTest } from '@/lib/types';
import { useAuth } from '@/lib/auth-context';

/**
 * What this laboratory offers, and what it charges.
 *
 * WHY THIS IS ON THE PHONE AT ALL
 * -------------------------------
 * It was web-only, recorded as "setup done once at a desk" — the same argument
 * that kept dispensing off the web because it happens "at the counter", and
 * reception off mobile behind a comment claiming the backend would refuse them
 * anyway. Every one of those turned out to be a story standing in for nobody
 * having built the other half.
 *
 * The argument is also wrong on its own terms here. An unpriced test is not
 * setup: it is a test that goes out uncharged, discovered by whoever reconciles
 * the month, and it is the exact counterpart of an unpriced medicine — which
 * the phone *does* surface, on the pharmacy screens and the admin overview.
 * Pricing one is a single number typed while looking at the bench.
 *
 * WHAT STAYS ON THE WEB, AND WHY THAT IS NOT THE SAME OMISSION
 * ------------------------------------------------------------
 * Creating a test — its code, category, specimen type, analytes and reference
 * ranges — is genuinely a desk job with a table of intervals to hand, and it
 * lives on the admin screen with the rest of the configuration. This screen is
 * the technician's read of the catalogue plus the one field they act on, which
 * is exactly what the web's `/lab/catalogue` is.
 */
export default function LabCatalogueScreen() {
  const money = useMoney();
  const { user } = useAuth();
  /*
   * Administrators may add a test; a technician prices one.
   *
   * The full form — category, specimen type, analytes and their reference
   * ranges — genuinely wants a desk, and it stays on the web. What is here is
   * the minimum that unblocks a real situation: a referral arrives naming a
   * test this laboratory does not have, and somebody has to create it before
   * the work can be accepted. Refusing that on a phone means the referral waits
   * until whoever holds the laptop is back.
   *
   * Created without analytes, so results are entered as findings until an
   * administrator completes it on the web. That is stated on the form rather
   * than discovered.
   */
  const canCreate = user?.role === 'ADMIN';
  const [creating, setCreating] = useState(false);
  const [newCode, setNewCode] = useState('');
  const [newName, setNewName] = useState('');
  const [tests, setTests] = useState<LabTest[] | null>(null);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<number | null>(null);
  const [price, setPrice] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api<{ data: LabTest[] }>('/lab-tests');
      setTests(res.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the catalogue');
    }
  }, []);

  useLiveData(load);

  async function savePrice(id: number) {
    setBusy(true);
    setError(null);
    try {
      await api(`/lab-tests/${id}`, { method: 'PATCH', body: { sellingPrice: price.trim() } });
      setEditing(null);
      setPrice('');
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not set that price');
    } finally {
      setBusy(false);
    }
  }

  async function create() {
    setBusy(true);
    setError(null);
    try {
      await api('/lab-tests', {
        method: 'POST',
        body: {
          code: newCode.trim().toUpperCase(),
          name: newName.trim(),
          category: 'OTHER',
          specimenType: 'BLOOD',
          sellingPrice: null,
          turnaroundHours: null,
          preparation: null,
          analytes: [],
        },
      });
      setNewCode('');
      setNewName('');
      setCreating(false);
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not add that test');
    } finally {
      setBusy(false);
    }
  }

  const q = query.trim().toLowerCase();
  const matching = (tests ?? []).filter(
    (t) => !q || t.name.toLowerCase().includes(q) || t.code.toLowerCase().includes(q),
  );

  /*
   * Unpriced first, because it is the only thing on this screen anybody has to
   * act on — the same ordering the web uses. Blank is not zero: a test with no
   * price is one nobody has priced, and it will still be run and still leave
   * the bench uncharged.
   */
  const ordered = [...matching].sort((a, b) => {
    const unpricedA = a.sellingPrice === null ? 0 : 1;
    const unpricedB = b.sellingPrice === null ? 0 : 1;
    return unpricedA - unpricedB || a.name.localeCompare(b.name);
  });

  const unpriced = (tests ?? []).filter((t) => t.sellingPrice === null).length;

  return (
    <Screen>
      <AppHeader
        title="Test catalogue"
        subtitle={
          tests === null
            ? 'Loading…'
            : unpriced > 0
              ? `${unpriced} with no price`
              : `${tests.length} tests, all priced`
        }
      />

      <View style={s.search}>
        <Field
          value={query}
          onChange={setQuery}
          placeholder="Search by name or code"
          autoCapitalize="none"
        />
      </View>

      {canCreate && !creating && (
        <View style={s.search}>
          <Button label="+  Add a test" variant="secondary" onPress={() => setCreating(true)} />
        </View>
      )}

      {canCreate && creating && (
        <View style={s.createBox}>
          <Field label="Code" value={newCode} onChange={setNewCode} placeholder="FBC" autoCapitalize="characters" />
          <Field label="Name" value={newName} onChange={setNewName} placeholder="Full blood count" autoCapitalize="sentences" />
          <Text style={s.muted}>
            Created with no analytes or reference ranges — results are entered as findings until an
            administrator completes it on the web.
          </Text>
          <View style={s.editRow}>
            <Button label="Add" busy={busy} disabled={!newCode.trim() || !newName.trim()} onPress={() => void create()} />
            <Button label="Cancel" variant="ghost" onPress={() => setCreating(false)} />
          </View>
        </View>
      )}

      {error && <ErrorBanner message={error} />}

      <FlatList
        data={ordered}
        keyExtractor={(t) => String(t.id)}
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
          tests === null ? null : (
            <EmptyState
              glyph="⌸"
              title={q ? 'No tests matched' : 'No tests yet'}
              body={
                q
                  ? 'Try the code instead.'
                  : 'An administrator adds tests on the web, with their analytes and reference ranges.'
              }
            />
          )
        }
        renderItem={({ item }) => (
          <Card>
            <View style={s.row}>
              <View style={s.grow}>
                <Text style={s.name}>{item.name}</Text>
                <Text style={s.muted}>
                  {item.code} · {item.category.toLowerCase()}
                  {item.specimenType === 'NONE' ? '' : ` · ${item.specimenType.toLowerCase()}`}
                </Text>
              </View>
              <Text style={item.sellingPrice === null ? s.unpriced : s.price}>
                {item.sellingPrice === null ? 'No price' : money(item.sellingPrice)}
              </Text>
            </View>

            {editing === item.id ? (
              <View style={s.editRow}>
                <TextInput
                  style={s.input}
                  value={price}
                  onChangeText={setPrice}
                  placeholder="0.00"
                  placeholderTextColor={theme.color.textSubtle}
                  keyboardType="decimal-pad"
                  autoFocus
                />
                <Button
                  label="Save"
                  busy={busy}
                  disabled={!price.trim()}
                  onPress={() => void savePrice(item.id)}
                />
                <Button label="Cancel" variant="ghost" onPress={() => setEditing(null)} />
              </View>
            ) : (
              <Button
                label={item.sellingPrice === null ? 'Set price' : 'Change price'}
                variant="secondary"
                onPress={() => {
                  setEditing(item.id);
                  setPrice(item.sellingPrice ?? '');
                }}
              />
            )}
          </Card>
        )}
      />
    </Screen>
  );
}

const s = StyleSheet.create({
  search: { paddingHorizontal: theme.space(4), paddingTop: theme.space(3) },
  createBox: { padding: theme.space(4), paddingBottom: 0, gap: theme.space(2) },
  list: { padding: theme.space(4), gap: theme.space(3) },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: theme.space(2) },
  grow: { flex: 1 },
  name: { ...theme.font.body, fontWeight: '700', color: theme.color.text },
  muted: { ...theme.font.caption, color: theme.color.textMuted },
  price: { ...theme.font.body, color: theme.color.text },
  unpriced: { ...theme.font.caption, color: theme.color.warning, fontWeight: '700' },
  editRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space(2),
    marginTop: theme.space(2),
  },
  input: {
    ...theme.font.body,
    flex: 1,
    color: theme.color.text,
    borderWidth: 1,
    borderColor: theme.color.border,
    borderRadius: theme.radius.md,
    paddingHorizontal: theme.space(3),
    paddingVertical: theme.space(2),
    backgroundColor: theme.color.surface,
  },
});
