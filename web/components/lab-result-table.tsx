'use client';

import type { LabOrder, LabOrderItem, LabResultFlag, LabResultValue } from '@/lib/types';

/**
 * How a result renders, everywhere it renders.
 *
 * One component because the alternative is the ward, the doctor's list and the
 * lab's own screen each deciding independently what an abnormal value looks
 * like — and the failure that produces is not a cosmetic one. A flag rendered
 * as a pale colour on one screen and a word on another means a nurse who learnt
 * the first cannot read the second.
 *
 * THE RULE THIS ENFORCES
 * ----------------------
 * **UNKNOWN is not NORMAL.** A value the lab could not compare against a range
 * shows no flag and a muted dash under Reference — never "Normal", never a
 * green tick. Collapsing the two would make an unconfigured catalogue look like
 * a clean bill of health, which is worse than showing nothing at all.
 */

const FLAG_LABEL: Record<LabResultFlag, string> = {
  NORMAL: '',
  LOW: 'Low',
  HIGH: 'High',
  ABNORMAL: 'Abnormal',
  CRITICAL_LOW: 'CRITICAL LOW',
  CRITICAL_HIGH: 'CRITICAL HIGH',
  UNKNOWN: '',
};

/**
 * Critical is not a stronger shade of high.
 *
 * It is the row somebody has to telephone about, and giving it the same
 * treatment as a mildly raised value throws away the only piece of information
 * that changes what happens in the next ten minutes.
 */
function flagClass(flag: LabResultFlag): string {
  if (flag === 'CRITICAL_LOW' || flag === 'CRITICAL_HIGH') {
    return 'bg-danger-soft font-semibold text-[#8a2a1f]';
  }
  if (flag === 'LOW' || flag === 'HIGH' || flag === 'ABNORMAL') {
    return 'text-[#6b5314]';
  }
  return '';
}

export function LabValueRows({ values }: { values: LabResultValue[] }) {
  if (values.length === 0) return null;

  return (
    <table className="w-full text-sm">
      <thead className="bg-bg text-left text-xxs uppercase text-text-subtle">
        <tr>
          <th className="px-3 py-1.5">Analyte</th>
          <th className="px-3 py-1.5">Result</th>
          <th className="px-3 py-1.5">Units</th>
          <th className="px-3 py-1.5">Reference</th>
          <th className="px-3 py-1.5">Flag</th>
        </tr>
      </thead>
      <tbody>
        {values.map((v) => (
          <tr key={v.id} className={`border-t border-border ${flagClass(v.flag)}`}>
            <td className="px-3 py-1.5">{v.analyteName}</td>
            {/* Monospaced so a column of numbers lines up — the thing being
                compared between rows is the digits. */}
            <td className="px-3 py-1.5 font-mono font-medium">{v.value}</td>
            <td className="px-3 py-1.5 text-xs text-text-muted">{v.unit ?? ''}</td>
            <td className="px-3 py-1.5 font-mono text-xs text-text-muted">
              {/* A dash rather than a blank: "no range was defined" is a fact
                  about the catalogue, and an empty cell reads as a rendering
                  fault. */}
              {v.referenceRange ?? '—'}
            </td>
            <td className="px-3 py-1.5 text-xs">{FLAG_LABEL[v.flag]}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** One test on a report: its values, then whatever narrative came with it. */
export function LabItemPanel({ item }: { item: LabOrderItem }) {
  const nothing =
    item.values.length === 0 && !item.findings && !item.impression && item.resultedAt !== null;

  return (
    <div className="mb-3 overflow-hidden rounded-md border border-border">
      <div className="flex items-baseline gap-2 border-b border-border bg-bg px-3 py-2">
        <span className="font-mono text-xs text-text-muted">{item.testCode}</span>
        <span className="text-sm font-medium text-text">{item.testName}</span>
        {item.criticalNotifiedAt && (
          <span className="ml-auto text-xxs uppercase text-text-subtle">
            Called through to {item.criticalNotifiedTo}
          </span>
        )}
      </div>

      <LabValueRows values={item.values} />

      {item.findings && <Prose label="Findings" text={item.findings} />}
      {item.impression && <Prose label="Impression" text={item.impression} />}
      {item.methodology && <Prose label="Method" text={item.methodology} />}
      {item.performedByName && (
        <p className="px-3 py-1.5 text-xxs text-text-subtle">
          Performed by {item.performedByName}
        </p>
      )}

      {nothing && (
        /* Said out loud rather than left as a gap. A heading with nothing
           under it reads as "normal, nothing to report", which is a claim
           nobody made. */
        <p className="px-3 py-2 text-sm text-text-muted">No result was recorded for this test.</p>
      )}
    </div>
  );
}

function Prose({ label, text }: { label: string; text: string }) {
  return (
    <div className="border-t border-border px-3 py-2">
      <div className="text-xxs font-semibold uppercase tracking-wider text-text-subtle">
        {label}
      </div>
      <p className="whitespace-pre-wrap text-sm text-text">{text}</p>
    </div>
  );
}

/**
 * The banner above a report that has not been authorised.
 *
 * The API withholds the values, so without this the screen would show an order
 * with an empty result panel — indistinguishable from a test that found
 * nothing. Naming the state is the whole job.
 */
export function LabAuthorisationNotice({ order }: { order: LabOrder }) {
  if (order.status === 'CANCELLED') {
    return (
      <Notice tone="muted">
        <strong>Cancelled.</strong> {order.cancelReason}
      </Notice>
    );
  }

  if (order.status === 'REJECTED') {
    return (
      <Notice tone="warn">
        <strong>Sample could not be used — another one is needed.</strong>{' '}
        {order.rejectReason}
      </Notice>
    );
  }

  if (order.resultsAuthorised) return null;

  return (
    <Notice tone="muted">
      <strong>Not reported yet.</strong> Results appear here once the laboratory has authorised
      them. A value that has not been checked is not something to act on, so it is not shown.
    </Notice>
  );
}

function Notice({ tone, children }: { tone: 'muted' | 'warn'; children: React.ReactNode }) {
  const cls =
    tone === 'warn'
      ? 'border-[#ecdca6] bg-warning-soft text-[#6b5314]'
      : 'border-border bg-bg text-text-muted';
  return <div className={`mb-3 rounded-sm border px-3 py-2 text-sm ${cls}`}>{children}</div>;
}
