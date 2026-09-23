import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { apiOrigin, session } from './api';

/**
 * Downloading a printable document on the phone.
 *
 * WHY NOT JUST OPEN THE URL
 * -------------------------
 * The access token lives in memory and travels in an `Authorization` header —
 * it is deliberately not a cookie. Handing the URL to the system browser or to
 * `Linking.openURL` sends an unauthenticated request, which comes back 401, and
 * the failure looks to the doctor like the prescription does not exist.
 *
 * So the file is fetched with the header attached and written to the app's
 * cache directory, from where the OS viewer or share sheet can open it.
 *
 * The token is never put in the query string. `AuditInterceptor` records the
 * path, so a credential there would be written into the audit table — the one
 * table that is append-only and widely read by administrators.
 */
/**
 * The period a statement covers, as hospital-local calendar days.
 *
 * A range rather than a month: referral agreements are written weekly,
 * ten-daily and fortnightly as often as monthly. Both ends always travel — the
 * server refuses one without the other rather than inferring a boundary nobody
 * chose on a document about money.
 */
export interface StatementPeriod {
  from: string;
  to: string;
}

export type DocumentKind =
  | 'prescriptions'
  | 'invoices'
  | 'records'
  | 'lab-orders'
  /** The stickers for the tubes, not a report — see `specimen-label.ts`. */
  | 'specimen-labels'
  /**
   * A month of referred work, for the laboratory to send to the hospital that
   * referred it. The `id` is the *referring hospital's* tenant rather than a
   * record of ours, and the month travels as a query parameter.
   */
  | 'lab-statements';

export async function downloadDocument(
  kind: DocumentKind,
  id: number,
  /** Only `lab-statements` uses it: the period being billed. */
  month?: StatementPeriod,
): Promise<string> {
  const token = session.getAccessToken();
  if (!token) throw new Error('Signed out — sign in again to print');

  const target = `${FileSystem.cacheDirectory}${kind}-${id}.pdf`;
  const auth = { headers: { Authorization: `Bearer ${token}` } };
  const origin = apiOrigin();
  /*
   * The one document here that is about a period rather than a record. Empty
   * when absent, and the server then resolves "this month" in the hospital's
   * own timezone — which is the only place that question can be answered.
   */
  const period =
    month?.from && month.to
      ? `?from=${encodeURIComponent(month.from)}&to=${encodeURIComponent(month.to)}`
      : '';

  /*
   * One literal URL per document, rather than one interpolated path.
   *
   * `${origin}/api/v1/documents/${kind}/${id}/pdf` is shorter and invisible to
   * `endpoint-coverage.spec.ts`, which matches `(method, path)` structurally —
   * a fully interpolated segment matches no route, so every one of these would
   * have read
   * as having no mobile caller. The available fix was a `MOBILE_ONLY` exemption
   * saying the phone does not call them, which would have been false: this file
   * is the only caller. A false reason in an exemption list is worse than no
   * list, because it reads as a decision somebody made.
   */
  const result =
    kind === 'prescriptions'
      ? await FileSystem.downloadAsync(
          `${origin}/api/v1/documents/prescriptions/${id}/pdf`,
          target,
          auth,
        )
      : kind === 'invoices'
        ? await FileSystem.downloadAsync(
            `${origin}/api/v1/documents/invoices/${id}/pdf`,
            target,
            auth,
          )
        : kind === 'lab-orders'
          ? await FileSystem.downloadAsync(
              `${origin}/api/v1/documents/lab-orders/${id}/pdf`,
              target,
              auth,
            )
          : // A literal per document, and it must be the *first* thing inside
          // `downloadAsync(` — `endpoint-coverage.spec.ts` reads the literal at
          // that position, so a comment between the paren and the string makes
          // the call invisible to it and the route reads as having no mobile
          // caller. Found exactly that way.
          kind === 'specimen-labels'
          ? await FileSystem.downloadAsync(
              `${origin}/api/v1/documents/lab-orders/${id}/labels`,
              target,
              auth,
            )
          : // Again the literal first, immediately after the paren — a comment
          // between it and the string makes the call invisible to
          // `endpoint-coverage.spec.ts`, which reads that position.
          kind === 'lab-statements'
          ? await FileSystem.downloadAsync(
              `${origin}/api/v1/documents/lab-statements/${id}/pdf${period}`,
              target,
              auth,
            )
          : await FileSystem.downloadAsync(
              `${origin}/api/v1/documents/records/${id}/pdf`,
              target,
              auth,
            );

  /*
   * A non-200 still writes a file — the error body — so the status has to be
   * checked explicitly. Without this the share sheet opens on a PDF viewer
   * showing a JSON error, which reads as a corrupt document rather than as a
   * refusal.
   */
  if (result.status !== 200) {
    await FileSystem.deleteAsync(target, { idempotent: true });
    if (result.status === 401) throw new Error('Session expired — sign in again');
    if (result.status === 403) throw new Error('You do not have permission to print this');
    if (result.status === 404) throw new Error('That document no longer exists');
    throw new Error('Could not produce that document');
  }

  return result.uri;
}

/**
 * Download and hand to the OS share sheet.
 *
 * From there a doctor can send it to a printer, save it to Files, or message it
 * to the patient — the phone already knows how to do all three, and building
 * any of them here would be a worse version of what the platform provides.
 *
 * The failure mode worth naming: `isAvailableAsync` is false on a simulator
 * without a share extension, and on Android Go. Saying so beats a button that
 * appears to do nothing.
 */
/**
 * Open a file a technician uploaded.
 *
 * Downloaded with the header and handed to the share sheet, exactly as the
 * rendered documents are — a plain URL would arrive unauthenticated and 401,
 * and the token is never put in the query string because `AuditInterceptor`
 * records the path.
 *
 * A literal URL, not one built from a variable: `endpoint-coverage.spec.ts`
 * matches on the literal at the call site, and an interpolated segment matches
 * no route — which would report this as having no mobile caller and invite an
 * exemption saying so, which would be false.
 */
export async function openLabAttachment(id: number): Promise<void> {
  const token = session.getAccessToken();
  if (!token) throw new Error('Signed out — sign in again to open files');

  const target = `${FileSystem.cacheDirectory}lab-attachment-${id}`;
  const result = await FileSystem.downloadAsync(
    `${apiOrigin()}/api/v1/lab/attachments/${id}/file`,
    target,
    { headers: { Authorization: `Bearer ${token}` } },
  );

  /*
   * A non-200 still writes a file — the error body — so the status is checked
   * explicitly. Without this the share sheet opens on a JSON error, which reads
   * as a corrupt document rather than as "not authorised yet".
   */
  if (result.status !== 200) {
    throw new Error(
      result.status === 403
        ? 'That report has not been authorised yet.'
        : 'Could not open that file.',
    );
  }

  if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(result.uri);
}

/**
 * Send a file up from the phone.
 *
 * `FormData` with a React Native file descriptor. The `Content-Type` header is
 * deliberately not set — the runtime adds its own multipart boundary, and
 * setting it by hand produces a body the server cannot parse.
 */
export async function uploadLabAttachment(
  itemId: number,
  file: { uri: string; name: string; mimeType?: string },
  meta: { kind?: string } = {},
): Promise<void> {
  const token = session.getAccessToken();
  if (!token) throw new Error('Signed out — sign in again to attach files');

  const body = new FormData();
  body.append('file', {
    uri: file.uri,
    name: file.name,
    // A hint only. The server reads the file's own leading bytes and refuses
    // anything that is not a PDF or a Word document, whatever this says.
    type: file.mimeType ?? 'application/octet-stream',
  } as unknown as Blob);
  if (meta.kind) body.append('kind', meta.kind);

  const res = await fetch(`${apiOrigin()}/api/v1/lab/items/${itemId}/attachments`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body,
  });

  if (!res.ok) {
    // The server's own refusal — it names the file type or the size, and
    // paraphrasing it would throw away the only actionable part.
    let detail = 'Could not attach that file';
    try {
      const parsed = (await res.json()) as { detail?: string; title?: string };
      detail = parsed.detail ?? parsed.title ?? detail;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(detail);
  }
}

export async function shareDocument(
  kind: DocumentKind,
  id: number,
  month?: StatementPeriod,
): Promise<void> {
  const uri = await downloadDocument(kind, id, month);

  if (!(await Sharing.isAvailableAsync())) {
    throw new Error('Sharing is not available on this device');
  }

  await Sharing.shareAsync(uri, {
    mimeType: 'application/pdf',
    UTI: 'com.adobe.pdf',
    dialogTitle:
      kind === 'prescriptions' ? 'Prescription' : kind === 'lab-statements' ? 'Statement' : 'Document',
  });
}
