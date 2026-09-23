'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import type { WardSetupRow } from '@/lib/types';
import {
  Button,
  EmptyState,
  ErrorState,
  Field,
  Input,
  TableSkeleton,
} from '@/components/ui/primitives';
import { Sheet } from '@/components/ui/sheet';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';

/**
 * Wards and beds.
 *
 * WHY THIS SCREEN EXISTS, AND WHAT ITS ABSENCE COST
 * -------------------------------------------------
 * Wards and beds were created by `seed.ts` and by nothing else — there was no
 * API to make one, so every hospital provisioned through the platform had
 * none, and the only fix was a database console.
 *
 * The bill landed on the nurse, whose landing screen is the ward board.
 * `GET /wards` returned an empty list, so no ward was selected, so the board
 * was never requested, so the page sat on its loading skeleton indefinitely.
 * It was reported as a slow or hung backend. Nothing was slow. The hospital
 * had no wards and no screen said so.
 *
 * Same shape as the medicine catalogue, which was seed-only for six phases and
 * was found the same way — on a real deployment, by a user, with an empty
 * screen that explained nothing.
 *
 * OPERATIONAL, NOT CLINICAL
 * -------------------------
 * A ward is a room and a bed is furniture, so this is admin work like
 * departments and staff accounts. What it deliberately does not show is who is
 * *in* the bed: occupancy is a number here, and the board that names patients
 * stays closed to admin. That line is asserted in `access-matrix.spec.ts`.
 */
export default function WardsPage() {
  const [rows, setRows] = useState<WardSetupRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<WardSetupRow | 'new' | null>(null);
  const [addingBedsTo, setAddingBedsTo] = useState<WardSetupRow | null>(null);
  const [deletingWard, setDeletingWard] = useState<WardSetupRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const load = useCallback(async () => {
    setError(null);
    try {
      setRows(await api<WardSetupRow[]>('/wards/setup'));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load wards');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function toggle(id: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function confirmDeleteWard() {
    if (!deletingWard) return;
    setBusy(true);
    try {
      await api(`/wards/${deletingWard.id}`, { method: 'DELETE' });
      setDeletingWard(null);
      await load();
    } catch (err) {
      // Refused when any of its beds has ever held a patient — the server
      // names which, because "it has history" is not actionable on its own.
      setError(err instanceof ApiError ? err.message : 'Could not delete that ward');
      setDeletingWard(null);
    } finally {
      setBusy(false);
    }
  }

  async function setBedActive(bedId: number, isActive: boolean) {
    try {
      await api(`/wards/beds/${bedId}`, { method: 'PATCH', body: { isActive } });
      await load();
    } catch (err) {
      // Refused for an occupied bed. A bed cannot be both closed and holding
      // somebody, and the server says to discharge or transfer first.
      setError(err instanceof ApiError ? err.message : 'Could not update that bed');
    }
  }

  async function deleteBed(bedId: number) {
    try {
      await api(`/wards/beds/${bedId}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not remove that bed');
    }
  }

  if (error && !rows) return <ErrorState message={error} onRetry={() => void load()} />;

  const totalBeds = rows?.reduce((n, w) => n + w.beds.length, 0) ?? 0;

  return (
    <>
      <div className="flex shrink-0 items-center gap-3 border-b border-border bg-surface px-4 py-2">
        <span className="text-xs text-text-muted">
          {rows?.length ?? 0} wards · {totalBeds} beds
        </span>
        <Button variant="primary" className="ml-auto" onClick={() => setEditing('new')}>
          Add ward
        </Button>
      </div>

      {error && rows && (
        <div
          role="alert"
          className="shrink-0 border-b border-[#f2c4be] bg-danger-soft px-4 py-2 text-sm text-[#8a2a1f]"
        >
          {error}
        </div>
      )}

      <div className="scroll-thin flex-1 overflow-y-auto bg-surface">
        {!rows && <TableSkeleton cols={4} />}

        {rows?.length === 0 && (
          /*
           * Not a bare "no wards yet". This is the screen that fixes the
           * nurse's blank ward board, and an administrator arriving here needs
           * to know that is what they are doing — otherwise adding a ward
           * looks optional.
           */
          <EmptyState
            title="No wards yet"
            description="Until a ward with beds exists, nobody can be admitted and the nurses' ward board and drug round both come up empty. Add one to get started."
          />
        )}

        {rows && rows.length > 0 && (
          <div className="divide-y divide-border">
            {rows.map((w) => {
              const open = expanded.has(w.id);
              const occupied = w.beds.filter((b) => b.occupied).length;
              const closed = w.beds.filter((b) => !b.isActive).length;

              return (
                <div key={w.id}>
                  <div className="flex items-center gap-3 px-4 py-2.5 hover:bg-[#fafbfc]">
                    <button
                      onClick={() => toggle(w.id)}
                      className="flex flex-1 items-baseline gap-2 text-left"
                      aria-expanded={open}
                    >
                      <span className="font-mono text-xs text-text-subtle">{open ? '▾' : '▸'}</span>
                      <span className="font-medium text-text">{w.name}</span>
                      {w.floor && <span className="text-xs text-text-subtle">{w.floor}</span>}
                    </button>

                    <span className="font-mono text-xs text-text-muted">
                      {w.beds.length} beds
                      {occupied > 0 && <span className="text-warning"> · {occupied} occupied</span>}
                      {closed > 0 && <span className="text-text-subtle"> · {closed} closed</span>}
                    </span>

                    <div className="flex gap-1.5">
                      <Button size="sm" onClick={() => setAddingBedsTo(w)}>
                        Add beds
                      </Button>
                      <Button size="sm" onClick={() => setEditing(w)}>
                        Rename
                      </Button>
                      <Button size="sm" variant="danger" onClick={() => setDeletingWard(w)}>
                        Delete
                      </Button>
                    </div>
                  </div>

                  {open && (
                    <div className="bg-bg px-4 py-2">
                      {w.beds.length === 0 ? (
                        <p className="py-2 text-sm text-text-subtle">
                          This ward has no beds, so nobody can be admitted to it. Add some.
                        </p>
                      ) : (
                        <div className="flex flex-wrap gap-1.5 py-1">
                          {w.beds.map((b) => (
                            <div
                              key={b.id}
                              className={`flex items-center gap-2 rounded-sm border px-2 py-1 text-xs ${
                                b.occupied
                                  ? 'border-warning/40 bg-warning-soft'
                                  : b.isActive
                                    ? 'border-border bg-surface'
                                    : 'border-border bg-[#eef0f2] text-text-subtle'
                              }`}
                            >
                              <span className="font-mono font-semibold">{b.label}</span>
                              <span className="text-text-subtle">
                                {b.occupied ? 'occupied' : b.isActive ? 'free' : 'closed'}
                              </span>

                              {/*
                                An occupied bed offers neither control. Closing
                                it is refused by the server anyway; showing the
                                button and then explaining the refusal is worse
                                than not offering it.
                              */}
                              {!b.occupied && (
                                <>
                                  <button
                                    onClick={() => void setBedActive(b.id, !b.isActive)}
                                    className="text-primary hover:underline"
                                  >
                                    {b.isActive ? 'close' : 'reopen'}
                                  </button>
                                  <button
                                    onClick={() => void deleteBed(b.id)}
                                    className="text-danger hover:underline"
                                    title="Only possible for a bed that has never been used"
                                  >
                                    remove
                                  </button>
                                </>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <WardSheet
        subject={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          void load();
        }}
        onError={setError}
      />

      <AddBedsSheet
        ward={addingBedsTo}
        onClose={() => setAddingBedsTo(null)}
        onSaved={() => {
          setAddingBedsTo(null);
          void load();
        }}
        onError={setError}
      />

      <ConfirmDialog
        open={deletingWard !== null}
        title="Delete this ward?"
        consequence={
          deletingWard
            ? `${deletingWard.name} and its ${deletingWard.beds.length} beds will be removed. This is refused if any of its beds has ever held a patient — that history has to stay.`
            : ''
        }
        confirmLabel="Delete"
        busy={busy}
        onConfirm={() => void confirmDeleteWard()}
        onCancel={() => setDeletingWard(null)}
      />
    </>
  );
}

function WardSheet({
  subject,
  onClose,
  onSaved,
  onError,
}: {
  subject: WardSetupRow | 'new' | null;
  onClose: () => void;
  onSaved: () => void;
  onError: (m: string) => void;
}) {
  const isNew = subject === 'new';
  const [name, setName] = useState('');
  const [floor, setFloor] = useState('');
  const [bedCount, setBedCount] = useState('10');
  const [prefix, setPrefix] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!subject) return;
    setName(isNew ? '' : subject.name);
    setFloor(isNew ? '' : (subject.floor ?? ''));
    setBedCount('10');
    setPrefix('');
  }, [subject, isNew]);

  async function save() {
    setBusy(true);
    try {
      if (isNew) {
        await api('/wards', {
          method: 'POST',
          body: {
            name: name.trim(),
            floor: floor.trim() || undefined,
            bedCount: Number(bedCount) || 0,
            ...(prefix.trim() ? { bedPrefix: prefix.trim() } : {}),
          },
        });
      } else if (subject) {
        await api(`/wards/${subject.id}`, {
          method: 'PATCH',
          body: { name: name.trim(), floor: floor.trim() },
        });
      }
      onSaved();
    } catch (e) {
      onError(e instanceof ApiError ? e.message : 'Could not save that ward');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      open={subject !== null}
      onClose={onClose}
      title={isNew ? 'Add a ward' : 'Rename ward'}
      footer={
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy || !name.trim()} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <Field label="Ward name" required hint="What staff call it — “General Ward”, “ICU”.">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="General Ward" />
        </Field>

        <Field label="Floor or wing" hint="Optional. “2nd floor”, “East wing”.">
          <Input value={floor} onChange={(e) => setFloor(e.target.value)} placeholder="2nd floor" />
        </Field>

        {isNew && (
          <>
            {/*
              Beds are created with the ward rather than as a second step.
              A ward with no beds is not half-built, it is broken — nobody can
              be admitted and the board draws an empty table that looks exactly
              like a working one.
            */}
            <Field
              label="Beds to create now"
              hint="You can add more later. Labels are numbered automatically."
            >
              <Input
                type="number"
                min={0}
                max={200}
                value={bedCount}
                onChange={(e) => setBedCount(e.target.value)}
              />
            </Field>

            <Field label="Bed label prefix" hint="Leave blank to take it from the ward name.">
              <Input
                value={prefix}
                onChange={(e) => setPrefix(e.target.value)}
                placeholder="e.g. A — gives A-01, A-02, …"
              />
            </Field>
          </>
        )}
      </div>
    </Sheet>
  );
}

function AddBedsSheet({
  ward,
  onClose,
  onSaved,
  onError,
}: {
  ward: WardSetupRow | null;
  onClose: () => void;
  onSaved: () => void;
  onError: (m: string) => void;
}) {
  const [count, setCount] = useState('5');
  const [prefix, setPrefix] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!ward) return;
    setCount('5');
    // Offer the prefix already in use, so a second batch continues the same
    // series instead of starting a parallel one the ward board will interleave.
    setPrefix(ward.beds[0]?.label.split('-')[0] ?? '');
  }, [ward]);

  async function save() {
    if (!ward) return;
    setBusy(true);
    try {
      await api(`/wards/${ward.id}/beds`, {
        method: 'POST',
        body: { count: Number(count) || 1, ...(prefix.trim() ? { prefix: prefix.trim() } : {}) },
      });
      onSaved();
    } catch (e) {
      onError(e instanceof ApiError ? e.message : 'Could not add those beds');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      open={ward !== null}
      onClose={onClose}
      title={ward ? `Add beds to ${ward.name}` : 'Add beds'}
      footer={
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy} onClick={() => void save()}>
            {busy ? 'Adding…' : 'Add beds'}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <Field label="How many" required>
          <Input
            type="number"
            min={1}
            max={200}
            value={count}
            onChange={(e) => setCount(e.target.value)}
          />
        </Field>

        <Field
          label="Label prefix"
          hint="Numbering continues from the highest label already using this prefix, so adding twice does not collide."
        >
          <Input value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="A" />
        </Field>
      </div>
    </Sheet>
  );
}
