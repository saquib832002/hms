'use client';

import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import type { Medicine } from '@/lib/types';
import { Button, Field, Select, Skeleton } from '@/components/ui/primitives';
import { Sheet } from '@/components/ui/sheet';

interface UnmappedGroup {
  medicineName: string;
  itemIds: number[];
}

/**
 * Mapping free-text prescription items onto the catalogue.
 *
 * This is the human half of the Phase 4 migration. The backfill links items
 * whose `medicineName` matches a catalogue entry exactly; anything a
 * prescriber spelled differently — "amoxicillin 500", "Amoxil", a typo —
 * arrives here.
 *
 * It is not cosmetic tidying. An unmapped item cannot be allergy-checked by
 * drug class and cannot be dispensed against stock, and the dispensing screen
 * tells the pharmacist to map it. Without this screen that instruction was
 * impossible to follow.
 *
 * Grouped by the text as written, because the same misspelling recurs across
 * prescriptions and mapping it once per row would be miserable.
 */
export function MapMedicinesSheet({
  open,
  onClose,
  onMapped,
}: {
  open: boolean;
  onClose: () => void;
  onMapped: () => void;
}) {
  const [groups, setGroups] = useState<UnmappedGroup[] | null>(null);
  const [medicines, setMedicines] = useState<Medicine[]>([]);
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setGroups(null);
      setChoice({});
      setError(null);
      return;
    }
    void reload();
  }, [open]);

  async function reload() {
    try {
      const [unmapped, catalogue] = await Promise.all([
        api<{ data: UnmappedGroup[] }>('/medicines/unmapped'),
        api<{ data: Medicine[] }>('/medicines'),
      ]);
      setGroups(unmapped.data);
      setMedicines(catalogue.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load unmapped items');
    }
  }

  async function mapGroup(group: UnmappedGroup) {
    const medicineId = Number(choice[group.medicineName]);
    if (!medicineId) return;

    setBusy(group.medicineName);
    setError(null);
    try {
      // One call per item. The endpoint links a single item on purpose — the
      // prescribed text is never rewritten, only the catalogue link added, and
      // doing that per row keeps the audit entries individually attributable.
      for (const itemId of group.itemIds) {
        await api(`/medicines/items/${itemId}/link`, { method: 'PATCH', body: { medicineId } });
      }
      await reload();
      onMapped();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not map that medicine');
    } finally {
      setBusy(null);
    }
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      width="w-[480px]"
      title="Map medicines to the catalogue"
      footer={<Button onClick={onClose}>Close</Button>}
    >
      <p className="mb-3 text-sm text-text-muted">
        These prescription items are not linked to a catalogue entry, so they cannot be
        allergy-checked by drug class or dispensed against stock. The prescribed text stays exactly
        as written — mapping only adds the link.
      </p>

      {!groups && !error && <Skeleton className="h-40 w-full" />}

      {groups?.length === 0 && (
        <div className="rounded-sm border border-[#b7dcc5] bg-success-soft px-3 py-2 text-sm text-[#14562f]">
          Every prescription item is linked to the catalogue.
        </div>
      )}

      {groups?.map((group) => (
        <div key={group.medicineName} className="mb-3 rounded-sm border border-border bg-[#fcfcfd] p-2.5">
          <div className="text-sm font-semibold">{group.medicineName}</div>
          <div className="mb-2 text-xs text-text-muted">
            on {group.itemIds.length} prescription item{group.itemIds.length === 1 ? '' : 's'}
          </div>

          <Field label="Catalogue medicine">
            <Select
              value={choice[group.medicineName] ?? ''}
              onChange={(e) =>
                setChoice((c) => ({ ...c, [group.medicineName]: e.target.value }))
              }
            >
              <option value="">Select…</option>
              {medicines.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} {m.strength} ({m.form})
                </option>
              ))}
            </Select>
          </Field>

          <Button
            size="sm"
            variant="primary"
            disabled={!choice[group.medicineName] || busy === group.medicineName}
            onClick={() => void mapGroup(group)}
          >
            {busy === group.medicineName
              ? 'Linking…'
              : `Link ${group.itemIds.length} item${group.itemIds.length === 1 ? '' : 's'}`}
          </Button>
        </div>
      ))}

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
