'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import type { Inventory, InventoryRow, Medicine } from '@/lib/types';
import { date, isoDate, titleCase } from '@/lib/format';
import {
  Button,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Select,
  TableSkeleton,
} from '@/components/ui/primitives';
import { Sheet } from '@/components/ui/sheet';

/**
 * Stock, organised around the two questions a pharmacist actually asks:
 * what is running out, and what is about to expire.
 *
 * A flat list of quantities answers neither. Both states are surfaced as
 * counts at the top and as row-level colour, so the screen can be read in a
 * glance rather than scanned.
 */
export default function InventoryPage() {
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'low' | 'expiring' | 'expired'>('all');
  const [error, setError] = useState<string | null>(null);
  const [receiving, setReceiving] = useState(false);

  const load = useCallback(async (q: string) => {
    setError(null);
    try {
      setInventory(await api<Inventory>(`/pharmacy/inventory${q ? `?q=${encodeURIComponent(q)}` : ''}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load inventory');
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void load(query.trim()), query ? 250 : 0);
    return () => clearTimeout(t);
  }, [query, load]);

  if (error && !inventory) return <ErrorState message={error} onRetry={() => void load(query)} />;

  const rows = (inventory?.data ?? []).filter((r) => {
    if (filter === 'low') return r.belowReorderLevel;
    if (filter === 'expiring') return r.expiringSoon.length > 0;
    if (filter === 'expired') return r.expiredQuantity > 0;
    return true;
  });

  return (
    <>
      <div className="flex shrink-0 items-center gap-5 border-b border-border bg-surface px-4 py-2">
        <Stat label="Medicines" value={inventory?.stats.medicines ?? '—'} />
        <Stat label="Below reorder" value={inventory?.stats.belowReorderLevel ?? '—'} tone="warning" />
        <Stat label="Out of stock" value={inventory?.stats.outOfStock ?? '—'} tone="danger" />
        <Stat label="Expiring soon" value={inventory?.stats.expiringSoon ?? '—'} tone="warning" />
        <Stat label="Expired on shelf" value={inventory?.stats.hasExpiredStock ?? '—'} tone="danger" />

        <div className="ml-auto flex items-center gap-2">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter…"
            className="w-40 text-sm"
          />
          <Select
            value={filter}
            onChange={(e) => setFilter(e.target.value as typeof filter)}
            className="w-auto text-sm"
          >
            <option value="all">All</option>
            <option value="low">Below reorder</option>
            <option value="expiring">Expiring soon</option>
            <option value="expired">Has expired stock</option>
          </Select>
          <Button variant="primary" onClick={() => setReceiving(true)}>
            Receive stock
          </Button>
        </div>
      </div>

      <div className="scroll-thin flex-1 overflow-y-auto bg-surface">
        {!inventory && <TableSkeleton cols={6} />}
        {inventory && rows.length === 0 && (
          <EmptyState title="Nothing matches" description="Try a different filter." />
        )}

        {rows.length > 0 && (
          <table className="w-full border-collapse">
            <thead>
              <tr>
                {['Medicine', 'Form', 'Class', 'In date', 'Reorder at', 'Batches'].map((h) => (
                  <th
                    key={h}
                    className="sticky top-0 border-b border-border bg-surface px-3 py-2 text-left text-xxs font-semibold uppercase tracking-wider text-text-subtle"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <InventoryTableRow key={r.id} row={r} />
              ))}
            </tbody>
          </table>
        )}
      </div>

      <ReceiveStockSheet
        open={receiving}
        onClose={() => setReceiving(false)}
        onReceived={() => {
          setReceiving(false);
          void load(query.trim());
        }}
      />
    </>
  );
}

function InventoryTableRow({ row }: { row: InventoryRow }) {
  const critical = row.inDateQuantity === 0;
  return (
    <tr className={critical ? 'bg-danger-soft' : 'hover:bg-[#fafbfc]'}>
      <td className="border-b border-[#f0f2f4] px-3 py-2">
        <span className="font-medium">{row.name}</span>{' '}
        <span className="font-mono text-xs text-text-muted">{row.strength}</span>
        {row.isControlled && (
          <span className="ml-1.5 rounded-sm border border-border-strong px-1 text-xxs uppercase text-text-muted">
            Controlled
          </span>
        )}
      </td>
      <td className="border-b border-[#f0f2f4] px-3 py-2 text-text-muted">{row.form}</td>
      <td className="border-b border-[#f0f2f4] px-3 py-2 text-xs text-text-muted">
        {titleCase(row.drugClass)}
      </td>
      <td
        className={`border-b border-[#f0f2f4] px-3 py-2 font-mono text-xs ${
          critical ? 'font-bold text-danger' : row.belowReorderLevel ? 'font-semibold text-warning' : ''
        }`}
      >
        {row.inDateQuantity}
        {row.expiredQuantity > 0 && (
          <span title="Expired stock, excluded from the usable total" className="ml-1.5 text-danger">
            (+{row.expiredQuantity} expired)
          </span>
        )}
      </td>
      <td className="border-b border-[#f0f2f4] px-3 py-2 font-mono text-xs text-text-muted">
        {row.reorderLevel}
      </td>
      <td className="border-b border-[#f0f2f4] px-3 py-2 text-xs">
        {row.batches.length === 0 ? (
          <span className="text-text-subtle">none</span>
        ) : (
          <div className="flex flex-wrap gap-1">
            {row.batches.map((b) => (
              <span
                key={b.id}
                title={`${b.quantity} units, expires ${date(b.expiresAt)}`}
                className={`rounded-sm px-1.5 py-0.5 font-mono text-xxs ${
                  b.expired
                    ? 'bg-danger-soft text-danger line-through'
                    : row.expiringSoon.some((e) => e.id === b.id)
                      ? 'bg-warning-soft text-warning'
                      : 'bg-[#eef0f2] text-text-muted'
                }`}
              >
                {b.batchNumber} · {b.quantity}
              </span>
            ))}
          </div>
        )}
      </td>
    </tr>
  );
}

function ReceiveStockSheet({
  open,
  onClose,
  onReceived,
}: {
  open: boolean;
  onClose: () => void;
  onReceived: () => void;
}) {
  const [medicines, setMedicines] = useState<Medicine[]>([]);
  const [medicineId, setMedicineId] = useState('');
  const [batchNumber, setBatchNumber] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [quantity, setQuantity] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) {
      setMedicineId('');
      setBatchNumber('');
      setExpiresAt('');
      setQuantity('');
      setError(null);
      return;
    }
    api<{ data: Medicine[] }>('/medicines')
      .then((r) => setMedicines(r.data))
      .catch(() => setMedicines([]));
  }, [open]);

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      await api('/pharmacy/stock', {
        method: 'POST',
        body: {
          medicineId: Number(medicineId),
          batchNumber: batchNumber.trim(),
          expiresAt: new Date(`${expiresAt}T00:00:00Z`).toISOString(),
          quantity: Number(quantity),
        },
      });
      onReceived();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not record that delivery');
    } finally {
      setSubmitting(false);
    }
  }

  const valid = medicineId && batchNumber.trim() && expiresAt && Number(quantity) > 0;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Receive stock"
      footer={
        <>
          <Button variant="primary" disabled={!valid || submitting} onClick={() => void submit()}>
            {submitting ? 'Recording…' : 'Record delivery'}
          </Button>
          <Button onClick={onClose}>Cancel</Button>
        </>
      }
    >
      <Field label="Medicine" required>
        <Select value={medicineId} onChange={(e) => setMedicineId(e.target.value)}>
          <option value="">Select…</option>
          {medicines.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name} {m.strength} ({m.form})
            </option>
          ))}
        </Select>
      </Field>

      <Field
        label="Batch number"
        required
        hint="Receiving the same batch again adds to it rather than creating a duplicate."
      >
        <Input value={batchNumber} onChange={(e) => setBatchNumber(e.target.value)} maxLength={60} />
      </Field>

      <Field label="Expiry date" required hint="Stock that has already expired is rejected.">
        <Input
          type="date"
          value={expiresAt}
          min={isoDate()}
          onChange={(e) => setExpiresAt(e.target.value)}
        />
      </Field>

      <Field label="Quantity" required>
        <Input
          type="number"
          min={1}
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
        />
      </Field>

      {error && (
        <div
          role="alert"
          className="rounded-sm border border-[#f2c4be] bg-danger-soft px-2.5 py-2 text-sm text-[#8a2a1f]"
        >
          {error}
        </div>
      )}
    </Sheet>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | string;
  tone?: 'warning' | 'success' | 'danger';
}) {
  const colour =
    tone === 'warning'
      ? 'text-warning'
      : tone === 'success'
        ? 'text-success'
        : tone === 'danger'
          ? 'text-danger'
          : 'text-text';
  return (
    <div>
      <div className={`text-lg font-bold tracking-tight ${colour}`}>{value}</div>
      <div className="text-xxs uppercase tracking-wider text-text-muted">{label}</div>
    </div>
  );
}
