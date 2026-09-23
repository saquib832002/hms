'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { openLabAttachment, uploadLabAttachment } from '@/lib/documents';
import type { LabAttachment, LabAttachmentKind } from '@/lib/types';
import { dateTime } from '@/lib/format';
import { Button, Select } from '@/components/ui/primitives';

/**
 * Files attached to a lab result.
 *
 * WHY THIS EXISTS ALONGSIDE THE TYPED VALUES
 * ------------------------------------------
 * Analytes and a narrative cover a full blood count. They do not cover what a
 * laboratory most often actually produces: a signed PDF, an analyser's printout,
 * a histopathology report written in Word. Retyping one of those into a text box
 * loses the signature and the layout — and retyping a report is where
 * transcription errors come from.
 *
 * WHAT IS NOT ACCEPTED, AND WHY THE SCREEN SAYS SO
 * ------------------------------------------------
 * PDF and Word only. Images are refused deliberately: imaging results are a real
 * gap in this system, and accepting a JPEG here would look like closing it while
 * storing a radiograph in a form no radiologist can window or measure. The
 * refusal names the file type it was given, because the usual cause is the wrong
 * file rather than an unsupported one.
 */
export function LabAttachments({
  orderId,
  itemId,
  canUpload,
  authorised,
  onChanged,
}: {
  orderId: number;
  /** Which test a new file attaches to. Absent on a read-only view. */
  itemId?: number;
  canUpload: boolean;
  /** Before the report is signed off, only the laboratory sees these. */
  authorised: boolean;
  onChanged?: () => void;
}) {
  const [rows, setRows] = useState<LabAttachment[] | null>(null);
  const [kind, setKind] = useState<LabAttachmentKind>('REPORT');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await api<{ data: LabAttachment[] }>(`/lab/orders/${orderId}/attachments`);
      setRows(res.data);
    } catch {
      // Attachments are context, not a precondition. A failure here must not
      // stop somebody reading the values that did load.
      setRows([]);
    }
  }, [orderId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function attach(file: File) {
    if (!itemId) return;
    setBusy(true);
    setError(null);
    try {
      await uploadLabAttachment(itemId, file, { kind });
      await load();
      onChanged?.();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not attach that file');
    } finally {
      setBusy(false);
      // Cleared so picking the same file twice fires a change event the second
      // time — otherwise a retry after a refusal does nothing at all.
      if (picker.current) picker.current.value = '';
    }
  }

  async function remove(id: number, name: string) {
    if (!confirm(`Remove ${name}? This is only possible before the report is authorised.`)) return;
    try {
      await api(`/lab/attachments/${id}`, { method: 'DELETE' });
      await load();
      onChanged?.();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not remove that file');
    }
  }

  const list = rows ?? [];
  if (list.length === 0 && !canUpload) return null;

  return (
    <div className="mt-2 rounded-md border border-border bg-bg">
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        <span className="text-xxs font-semibold uppercase tracking-wider text-text-subtle">
          Attached files
        </span>
        {list.length > 0 && <span className="text-xxs text-text-subtle">{list.length}</span>}
      </div>

      {list.length === 0 ? (
        <p className="px-3 py-2 text-xs text-text-subtle">
          {canUpload
            ? 'Nothing attached. A signed report or an analyser printout goes here.'
            : 'No files.'}
        </p>
      ) : (
        <ul>
          {list.map((a) => (
            <li
              key={a.id}
              className="flex items-baseline gap-2 border-b border-border px-3 py-1.5 last:border-b-0"
            >
              <button
                type="button"
                onClick={() => void openLabAttachment(a.id)}
                className="text-sm text-primary hover:underline"
              >
                {a.fileName}
              </button>
              <span className="text-xxs text-text-subtle">
                {kindLabel(a.kind)} · {size(a.sizeBytes)}
              </span>
              <span className="ml-auto text-xxs text-text-subtle">
                {a.uploadedByName ?? 'the laboratory'} · {dateTime(a.uploadedAt)}
              </span>
              {canUpload && !authorised && (
                <button
                  type="button"
                  onClick={() => void remove(a.id, a.fileName)}
                  className="text-xs text-danger hover:underline"
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {canUpload && itemId && !authorised && (
        <div className="flex flex-wrap items-center gap-2 border-t border-border px-3 py-2">
          <Select
            value={kind}
            onChange={(e) => setKind(e.target.value as LabAttachmentKind)}
            className="max-w-44"
          >
            <option value="REPORT">Signed report</option>
            <option value="RAW">Analyser output</option>
            <option value="OTHER">Something else</option>
          </Select>

          <input
            ref={picker}
            type="file"
            /* A hint to the file picker, and nothing more. The server reads the
               file's own leading bytes and refuses anything else — an accept
               attribute is trivially bypassed and was never a check. */
            accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void attach(file);
            }}
            className="hidden"
          />

          <Button disabled={busy} onClick={() => picker.current?.click()}>
            {busy ? 'Attaching…' : 'Attach a file'}
          </Button>

          <span className="text-xxs text-text-subtle">PDF or Word, up to 10 MB.</span>
        </div>
      )}

      {canUpload && authorised && list.length > 0 && (
        /* Says why the buttons are gone rather than leaving a reader to work it
           out from their absence — which is indistinguishable from a broken
           screen. */
        <p className="border-t border-border px-3 py-1.5 text-xxs text-text-subtle">
          This report has been authorised, so its files are part of an issued document. A correction
          is a new order.
        </p>
      )}

      {error && (
        <p role="alert" className="border-t border-border px-3 py-1.5 text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

function kindLabel(kind: LabAttachmentKind): string {
  return kind === 'REPORT' ? 'Report' : kind === 'RAW' ? 'Analyser output' : 'Other';
}

/** Bytes as a person reads them. A doctor on a ward tablet cares about 4 MB. */
function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
