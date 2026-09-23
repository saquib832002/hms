'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import type { DispenseQueueItem } from '@/lib/types';
import { dateTime } from '@/lib/format';
import { Button, EmptyState, ErrorState, TableSkeleton } from '@/components/ui/primitives';
import { Freshness } from '@/components/freshness';
import { useAutoRefresh } from '@/lib/use-auto-refresh';
import { DispenseSheet } from '@/components/dispense-sheet';
import { MapMedicinesSheet } from '@/components/map-medicines-sheet';
import { DispenseHistorySheet } from '@/components/dispense-history-sheet';

/**
 * The dispensing queue.
 *
 * Oldest first, regardless of who wrote the prescription — the patient
 * standing at the counter has been waiting longest, and that is the only
 * ordering that makes sense from their side of it.
 */
export default function PharmacyQueuePage() {
  const [rows, setRows] = useState<DispenseQueueItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dispensing, setDispensing] = useState<number | null>(null);
  const [mapping, setMapping] = useState(false);
  const [history, setHistory] = useState(false);
  /** How many prescriptions from other hospitals are waiting on Incoming. */
  const [incoming, setIncoming] = useState<number | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api<{ data: DispenseQueueItem[] }>('/pharmacy/queue');
      setRows(res.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the dispensing queue');
    }

    /*
     * Incoming referrals are counted here, on the screen a pharmacist actually
     * watches.
     *
     * They are deliberately not *in* this queue: this list is built from local
     * `Prescription` rows and a referral is a transmitted copy owned by this
     * tenant with no prescription behind it. Merging them would mean two
     * different things in one table with half the actions disabled on each.
     *
     * But a separate page nobody looks at is the same as no page. A
     * prescription sent from another hospital sat in Incoming while the
     * pharmacist watched this screen and concluded the feature did not work —
     * which is the third time this month that a working thing was invisible
     * because nothing pointed at it.
     */
    try {
      const r = await api<{ data: unknown[] }>('/pharmacy/referrals');
      setIncoming(r.data.length);
    } catch {
      // A pharmacy with no partners gets a 403 or an empty list depending on
      // configuration; either way this is a signpost, not a function.
      setIncoming(0);
    }
  }, []);

  const { lastUpdated, refreshing, refreshNow } = useAutoRefresh(load, {
    enabled: dispensing === null && !mapping && !history,
  });

  useEffect(() => {
    void refreshNow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (error && !rows) return <ErrorState message={error} onRetry={() => void refreshNow()} />;

  return (
    <>
      <div className="flex shrink-0 items-center gap-5 border-b border-border bg-surface px-4 py-2">
        <Stat label="Waiting" value={rows?.length ?? '—'} tone="warning" />
        {/* A count that is also the way there. A number a pharmacist cannot
            click is a number they have to go looking for. */}
        {incoming !== null && incoming > 0 && (
          /*
            `Link`, never a bare <a>, for anything inside the app.
            ----------------------------------------------------
            The access token lives in memory only — deliberately, so that a
            stolen localStorage cannot resume a clinical session. A raw <a>
            is a full document load: React unmounts, the token goes with it,
            and the next request 401s. The user is bounced to the login screen
            and reads it as "the session timed out", which is exactly what
            happened here.
          */
          <Link
            href="/pharmacy/referrals"
            className="rounded-md border border-primary bg-primary-soft px-2.5 py-1 text-sm text-primary hover:underline"
          >
            <span className="font-semibold">{incoming}</span> from other hospitals →
          </Link>
        )}
        <Stat
          label="Partially dispensed"
          value={rows?.filter((r) => r.status === 'PARTIALLY_DISPENSED').length ?? '—'}
        />
        <Stat
          label="Needs mapping"
          value={rows?.filter((r) => r.hasUncataloguedItem).length ?? '—'}
          tone="danger"
        />
        <div className="ml-auto flex items-center gap-2">
          <Freshness
            lastUpdated={lastUpdated}
            refreshing={refreshing}
            onRefresh={() => void refreshNow()}
          />
          <Button onClick={() => setHistory(true)}>History</Button>
          <Button
            variant={rows?.some((r) => r.hasUncataloguedItem) ? 'primary' : 'default'}
            onClick={() => setMapping(true)}
          >
            Map medicines
          </Button>
        </div>
      </div>

      <div className="scroll-thin flex-1 overflow-y-auto bg-surface">
        {!rows && <TableSkeleton cols={6} />}
        {rows?.length === 0 && (
          <EmptyState title="Nothing waiting" description="Every prescription has been dispensed." />
        )}

        {rows && rows.length > 0 && (
          <table className="w-full border-collapse">
            <thead>
              <tr>
                {['Issued', 'Rx', 'Patient', 'Prescriber', 'Items', 'Status'].map((h) => (
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
                <tr
                  key={r.id}
                  onClick={() => setDispensing(r.id)}
                  className="cursor-pointer hover:bg-[#fafbfc]"
                >
                  <td className="border-b border-[#f0f2f4] px-3 py-2 font-mono text-xs text-text-muted">
                    {dateTime(r.issuedAt)}
                  </td>
                  <td className="border-b border-[#f0f2f4] px-3 py-2 font-mono text-xs">#{r.id}</td>
                  <td className="border-b border-[#f0f2f4] px-3 py-2 font-medium">
                    {r.patient.fullName}
                    {r.patient.hasAllergies && (
                      <span
                        title="Has recorded allergies"
                        className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-danger align-middle"
                      />
                    )}
                  </td>
                  <td className="border-b border-[#f0f2f4] px-3 py-2 text-text-muted">
                    {r.doctor ?? '—'}
                  </td>
                  <td className="border-b border-[#f0f2f4] px-3 py-2 font-mono text-xs">
                    {r.itemCount}
                  </td>
                  <td className="border-b border-[#f0f2f4] px-3 py-2">
                    {r.status === 'PARTIALLY_DISPENSED' ? (
                      <span className="rounded-full bg-warning-soft px-2 py-0.5 text-xxs font-semibold text-warning">
                        Part dispensed
                      </span>
                    ) : (
                      <span className="rounded-full bg-primary-soft px-2 py-0.5 text-xxs font-semibold text-primary">
                        Waiting
                      </span>
                    )}
                    {/* An item with no catalogue link cannot be allergy-checked
                        by class or dispensed against stock. Worth saying so in
                        the queue rather than at the counter. */}
                    {r.hasUncataloguedItem && (
                      <span
                        title="An item is not linked to the catalogue"
                        className="ml-1.5 rounded-full bg-danger-soft px-2 py-0.5 text-xxs font-semibold text-danger"
                      >
                        Needs mapping
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <DispenseSheet
        prescriptionId={dispensing}
        onClose={() => setDispensing(null)}
        onDispensed={() => {
          setDispensing(null);
          void refreshNow();
        }}
      />

      <MapMedicinesSheet
        open={mapping}
        onClose={() => setMapping(false)}
        onMapped={() => void refreshNow()}
      />

      <DispenseHistorySheet open={history} onClose={() => setHistory(false)} />
    </>
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
