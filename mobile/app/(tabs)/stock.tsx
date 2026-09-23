import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { api } from '@/lib/api';
import { useLiveData } from '@/lib/use-live-data';
import { theme } from '@/lib/theme';
import { date } from '@/lib/format';
import { AppHeader, Button, Card, ErrorBanner, Field, Screen } from '@/components/ui';
import type { DrugClass, Inventory, InventoryRow, Medicine } from '@/lib/types';

/**
 * Stock: what is here, what is running out, and how a delivery gets in.
 *
 * WHY THIS IS ON A PHONE
 * ----------------------
 * Receiving stock was web-only, on the reasoning that it is bulk entry against
 * a delivery note. That is right for a wholesale order and wrong for the case
 * that actually happens most: a box arrives, somebody opens it at the shelf,
 * and the batch number and expiry are printed on the carton in front of them.
 * Walking to a desk to type what you are holding is how a count goes stale.
 *
 * ADDING A MEDICINE IS HERE TOO, AND HAD TO BE
 * --------------------------------------------
 * `POST /medicines` had no caller anywhere for six phases. On a hospital that
 * did not run the demo seed the catalogue is empty, so "receive stock" offers
 * nothing to receive against and the pharmacy simply does not work. Nothing in
 * the app explained why — the screen just looked broken.
 */
export default function StockScreen() {
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [receiving, setReceiving] = useState<InventoryRow | null>(null);
  const [adding, setAdding] = useState(false);

  /*
   * Search, because receiving stock meant scrolling to find the row.
   *
   * This screen listed the whole catalogue and the only way to receive a
   * delivery was to scroll until you saw the medicine. That is fine against the
   * demo seed and unusable against a real catalogue — the pharmacist is holding
   * a carton with the name printed on it, and typing three characters is the
   * fastest input available. Reported from use.
   *
   * Held in a ref as well as in state: `useLiveData` refetches on focus and
   * every 15 seconds, and it closes over `load`. Without the ref, a poll would
   * fire the *first* render's `load` and quietly replace the filtered list with
   * the unfiltered one while somebody was reading it — the same shape as the
   * three mobile bugs where a screen fetched correctly and then discarded half
   * the answer.
   */
  const [query, setQuery] = useState('');
  const queryRef = useRef('');
  queryRef.current = query;

  /*
   * Expiry first by default.
   *
   * FEFO already decides which *batch* leaves the shelf on every dispense — no
   * display order can change that. What this changes is which *medicine* the
   * pharmacist thinks to push, and they can only judge that if the list says
   * so. Name order stays available: counting against a physical shelf runs
   * alphabetically.
   */
  const [sort, setSort] = useState<'expiry' | 'name'>('expiry');
  const sortRef = useRef<'expiry' | 'name'>('expiry');
  sortRef.current = sort;

  const load = useCallback(async () => {
    setError(null);
    try {
      const q = queryRef.current.trim();
      // Searched on the server rather than filtered here: the catalogue can be
      // thousands of rows, each carrying its batches, and shipping all of them
      // to filter on a phone degrades silently as a hospital grows.
      const params = new URLSearchParams({ sort: sortRef.current });
      if (q.length >= 2) params.set('q', q);
      setInventory(await api<Inventory>(`/pharmacy/inventory?${params.toString()}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load stock');
    }
  }, []);

  useLiveData(load);

  /*
   * Debounced, so typing a full name is one request rather than one per key.
   * Two characters before anything is sent — one matches most of a catalogue,
   * which is an expensive request for a useless list.
   *
   * The mount guard matters: `useLiveData` already loads on focus, so without
   * it every visit to this tab fires two identical requests.
   */
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    const q = query.trim();
    if (q.length === 1) return;
    const timer = setTimeout(() => void load(), q ? 250 : 0);
    return () => clearTimeout(timer);
  }, [query, sort, load]);

  const rows: InventoryRow[] = inventory?.data ?? [];
  const low = inventory?.stats.belowReorderLevel ?? 0;

  return (
    <Screen>
      <AppHeader
        title="Stock"
        subtitle={
          query.trim().length >= 2
            ? `${rows.length} matching “${query.trim()}”`
            : `${rows.length} medicines${low > 0 ? ` · ${low} low` : ''}`
        }
      />

      {error && <ErrorBanner message={error} />}

      <ScrollView
        contentContainerStyle={s.body}
        refreshControl={<RefreshControl refreshing={false} onRefresh={() => void load()} />}
      >
        <Field
          label=""
          value={query}
          onChange={setQuery}
          placeholder="Search by name…"
          autoCapitalize="none"
        />

        <View style={s.sortRow}>
          <Button
            label="Expiring first"
            size="sm"
            variant={sort === 'expiry' ? 'primary' : 'secondary'}
            onPress={() => setSort('expiry')}
          />
          <Button
            label="By name"
            size="sm"
            variant={sort === 'name' ? 'primary' : 'secondary'}
            onPress={() => setSort('name')}
          />
        </View>

        <Button label="Add a medicine" onPress={() => setAdding(true)} />

        {rows.length === 0 &&
          inventory !== null &&
          /*
           * "Nothing matches" and "the catalogue is empty" are different
           * problems with different fixes, and they render identically as an
           * empty list. An empty catalogue is the commonest reason a new
           * hospital's pharmacy looks broken, so it is worth saying plainly
           * rather than letting a search miss look like it.
           */
          (query.trim().length >= 2 ? (
            <Card style={s.empty}>
              <Text style={s.emptyTitle}>Nothing matches “{query.trim()}”</Text>
              <Text style={s.muted}>
                Stock has to attach to a catalogue entry. If this medicine is new, add it above
                first.
              </Text>
            </Card>
          ) : (
            <Card style={s.empty}>
              <Text style={s.emptyTitle}>The catalogue is empty</Text>
              <Text style={s.muted}>
                Nothing can be stocked or dispensed until a medicine exists. Add the first one
                above.
              </Text>
            </Card>
          ))}

        {rows.map((row) => (
          <Card key={row.id} style={s.card}>
            <View style={s.cardTop}>
              <View style={{ flex: 1 }}>
                <Text style={s.name} numberOfLines={1}>
                  {row.name} <Text style={s.strength}>{row.strength}</Text>
                </Text>
                <Text style={s.muted}>
                  {row.form} · {titleise(row.drugClass)}
                  {row.isControlled ? ' · controlled' : ''}
                </Text>
                {/* The soonest sellable unit to go out of date. "No stock" is
                    said in words rather than shown as a dash, because a dash
                    reads as missing data. */}
                <Text style={row.expiringSoon.length > 0 ? s.expiryWarn : s.muted}>
                  {row.earliestExpiry === null
                    ? 'Nothing in date'
                    : `Expires ${date(row.earliestExpiry)}`}
                </Text>
              </View>
              <Text
                style={[
                  s.qty,
                  row.inDateQuantity === 0
                    ? { color: theme.color.danger }
                    : row.belowReorderLevel
                      ? { color: theme.color.warning }
                      : null,
                ]}
              >
                {row.inDateQuantity}
              </Text>
            </View>

            {/* Stated per row rather than only as a count at the top — the
                number is meaningless without knowing what it should be. */}
            <Text style={s.muted}>
              Reorder at {row.reorderLevel}
              {row.expiredQuantity > 0 ? ` · ${row.expiredQuantity} expired` : ''}
            </Text>

            {row.batches.length > 0 && (
              <Text style={s.batches} numberOfLines={2}>
                {row.batches
                  .map((b) => `${b.batchNumber} ×${b.quantity}${b.expired ? ' (expired)' : ''}`)
                  .join(' · ')}
              </Text>
            )}

            <Button
              label="Receive delivery"
              variant="secondary"
              size="sm"
              onPress={() => setReceiving(row)}
            />
          </Card>
        ))}
      </ScrollView>

      {receiving && (
        <ReceiveSheet
          medicine={receiving}
          onClose={() => setReceiving(null)}
          onDone={() => {
            setReceiving(null);
            void load();
          }}
        />
      )}

      {adding && (
        <MedicineSheet
          onClose={() => setAdding(false)}
          onDone={() => {
            setAdding(false);
            void load();
          }}
        />
      )}
    </Screen>
  );
}

/* ───────────────────────── receive a delivery ───────────────────────── */

function ReceiveSheet({
  medicine,
  onClose,
  onDone,
}: {
  medicine: InventoryRow;
  onClose: () => void;
  onDone: () => void;
}) {
  const [batchNumber, setBatchNumber] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [quantity, setQuantity] = useState('');
  const [costPrice, setCostPrice] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expiresAt)) {
      return setError('Expiry must be a date like 2027-06-30.');
    }
    if (!(Number(quantity) > 0)) return setError('Quantity must be at least 1.');

    setBusy(true);
    setError(null);
    try {
      await api('/pharmacy/stock', {
        method: 'POST',
        body: {
          medicineId: medicine.id,
          batchNumber: batchNumber.trim(),
          /*
           * Midnight UTC. The expiry printed on a carton is a date, not an
           * instant — parsing it against the phone's local zone would shift it
           * a day either way depending on where the phone is.
           */
          expiresAt: `${expiresAt}T00:00:00.000Z`,
          quantity: Number(quantity),
          /*
           * Omitted rather than sent empty. The server reads `undefined` as
           * "leave whatever cost was recorded before", which is right for a
           * repeat delivery of the same batch at an unchanged price.
           */
          ...(costPrice.trim() ? { costPrice: costPrice.trim() } : {}),
        },
      });
      Alert.alert('Stock received', `${quantity} × ${medicine.name} added.`);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not record that delivery');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet title={`Receive ${medicine.name}`} onClose={onClose}>
      <Text style={s.muted}>
        {medicine.form} · {medicine.strength} · {medicine.inDateQuantity} in date
      </Text>

      <Field
        label="Batch number"
        value={batchNumber}
        onChange={setBatchNumber}
        placeholder="As printed on the carton"
        autoCapitalize="characters"
      />
      <Field
        label="Expires"
        value={expiresAt}
        onChange={setExpiresAt}
        placeholder="YYYY-MM-DD"
        keyboardType="numbers-and-punctuation"
      />
      <Field
        label="Quantity"
        value={quantity}
        onChange={setQuantity}
        placeholder="Units received"
        keyboardType="number-pad"
      />
      {/*
        On the batch rather than the medicine: the same tablet costs differently
        from a different supplier next month, and one figure on the catalogue
        would restate the margin on every past sale each time a box arrived.
      */}
      <Field
        label="Cost price (optional)"
        value={costPrice}
        onChange={setCostPrice}
        placeholder="Per unit — what you paid"
        keyboardType="decimal-pad"
      />

      {error && <Text style={s.error}>{error}</Text>}

      <View style={s.actions}>
        <Button
          label="Record delivery"
          busy={busy}
          disabled={!batchNumber.trim() || !expiresAt || !quantity}
          onPress={() => void submit()}
        />
        <Button label="Cancel" variant="secondary" disabled={busy} onPress={onClose} />
      </View>
    </Sheet>
  );
}

/* ───────────────────────── add a medicine ───────────────────────── */

const DRUG_CLASSES: DrugClass[] = [
  'PENICILLIN', 'CEPHALOSPORIN', 'SULFONAMIDE', 'MACROLIDE', 'TETRACYCLINE',
  'QUINOLONE', 'NSAID', 'OPIOID', 'STATIN', 'ACE_INHIBITOR', 'BETA_BLOCKER',
  'CALCIUM_CHANNEL_BLOCKER', 'DIURETIC', 'ANTICOAGULANT', 'ANTIDIABETIC',
  'CORTICOSTEROID', 'ANTIHISTAMINE', 'BRONCHODILATOR', 'OTHER',
];

function MedicineSheet({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState('');
  const [form, setForm] = useState('');
  const [strength, setStrength] = useState('');
  const [drugClass, setDrugClass] = useState<DrugClass>('OTHER');
  const [reorderLevel, setReorderLevel] = useState('20');
  const [sellingPrice, setSellingPrice] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api<Medicine>('/medicines', {
        method: 'POST',
        body: {
          name: name.trim(),
          form: form.trim(),
          strength: strength.trim(),
          drugClass,
          reorderLevel: Number(reorderLevel) || 0,
          // `null`, not omitted: blank has to be storable, or a medicine
          // priced by mistake could never be un-priced.
          sellingPrice: sellingPrice.trim() === '' ? null : sellingPrice.trim(),
        },
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add that medicine');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet title="Add a medicine" onClose={onClose}>
      <Field label="Name" value={name} onChange={setName} placeholder="Amoxicillin" />
      <Field label="Form" value={form} onChange={setForm} placeholder="Tablet" />
      <Field label="Strength" value={strength} onChange={setStrength} placeholder="500mg" />

      <Text style={s.label}>Drug class</Text>
      <View style={s.wrap}>
        {DRUG_CLASSES.map((c) => (
          <Button
            key={c}
            label={titleise(c)}
            size="sm"
            variant={drugClass === c ? 'primary' : 'secondary'}
            onPress={() => setDrugClass(c)}
          />
        ))}
      </View>

      {/*
        Said at the moment of choosing, not in a help page. A catalogue left on
        OTHER produces allergy checks that run, find nothing, and look healthy —
        worse than no check at all, because it gets trusted.
      */}
      {drugClass === 'OTHER' && (
        <View style={s.warn}>
          <Text style={s.warnText}>
            Allergy checking cannot match this medicine to anything. Set a real class unless it
            genuinely has none.
          </Text>
        </View>
      )}

      <Field
        label="Reorder level"
        value={reorderLevel}
        onChange={setReorderLevel}
        keyboardType="number-pad"
      />

      <Field
        label="Selling price"
        value={sellingPrice}
        onChange={setSellingPrice}
        placeholder="Per unit — one tablet, one ml"
        keyboardType="decimal-pad"
      />

      {/*
        The same distinction the consultation fee makes, said where it is being
        decided. Blank is not free: the medicine is still dispensed and still
        leaves stock, it is simply never charged for — and nobody finds out
        until a month of sales turns out to be missing.
      */}
      {sellingPrice.trim() === '' && (
        <View style={s.warn}>
          <Text style={s.warnText}>
            No price means this is handed over without being charged for. Enter 0 if it is
            genuinely free.
          </Text>
        </View>
      )}

      {error && <Text style={s.error}>{error}</Text>}

      <View style={s.actions}>
        <Button
          label="Add to catalogue"
          busy={busy}
          disabled={!name.trim() || !form.trim() || !strength.trim()}
          onPress={() => void submit()}
        />
        <Button label="Cancel" variant="secondary" disabled={busy} onPress={onClose} />
      </View>
    </Sheet>
  );
}

/* ───────────────────────────── pieces ───────────────────────────── */

function Sheet({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <View style={s.modalRoot}>
        <Pressable style={s.modalBackdrop} onPress={onClose} />
        <View style={s.modalCard}>
          <ScrollView keyboardShouldPersistTaps="handled">
            <Text style={s.modalTitle}>{title}</Text>
            {children}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function titleise(value: string): string {
  return value
    .split('_')
    .map((w) => w.charAt(0) + w.slice(1).toLowerCase())
    .join(' ');
}

const s = StyleSheet.create({
  body: { padding: theme.space(3), gap: theme.space(3), paddingBottom: theme.space(8) },
  sortRow: { flexDirection: 'row', gap: theme.space(2) },
  expiryWarn: { ...theme.font.caption, color: theme.color.warning, fontWeight: '600' },
  card: { gap: theme.space(1) },
  cardTop: { flexDirection: 'row', alignItems: 'flex-start', gap: theme.space(2) },
  name: { ...theme.font.heading, color: theme.color.text },
  strength: { ...theme.font.caption, color: theme.color.textMuted },
  muted: { ...theme.font.caption, color: theme.color.textSubtle },
  qty: { ...theme.font.display, color: theme.color.text, fontVariant: ['tabular-nums'] },
  batches: { ...theme.font.caption, color: theme.color.textMuted, marginTop: 2 },

  empty: { gap: theme.space(1) },
  emptyTitle: { ...theme.font.title, color: theme.color.text },

  label: {
    ...theme.font.caption,
    color: theme.color.textMuted,
    textTransform: 'uppercase',
    marginTop: theme.space(2),
  },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space(1), marginTop: theme.space(1) },
  warn: {
    backgroundColor: theme.color.warningSoft,
    borderRadius: theme.radius.sm,
    padding: theme.space(2),
    marginTop: theme.space(2),
  },
  warnText: { ...theme.font.caption, color: theme.color.warning, lineHeight: 16 },
  error: { ...theme.font.small, color: theme.color.danger, marginTop: theme.space(2) },
  actions: { gap: theme.space(2), marginTop: theme.space(3) },

  modalRoot: { flex: 1, justifyContent: 'flex-end' },
  modalBackdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(17,26,20,0.45)' },
  modalCard: {
    backgroundColor: theme.color.surface,
    borderTopLeftRadius: theme.radius.lg,
    borderTopRightRadius: theme.radius.lg,
    padding: theme.space(4),
    paddingBottom: theme.space(6),
    maxHeight: '88%',
  },
  modalTitle: { ...theme.font.title, color: theme.color.text, marginBottom: theme.space(2) },
});
