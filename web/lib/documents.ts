import { ApiError, getAccessToken, refreshAccessToken } from './api';

/**
 * Opening a printable document from the web app.
 *
 * WHY A PLAIN LINK CANNOT WORK
 * ----------------------------
 * The access token lives in a module variable, in memory only, and travels as
 * an `Authorization` header — deliberately not a cookie, because anything
 * readable by script is readable by an XSS payload. A browser navigation to
 * `/api/v1/...` sends no header at all, so the request arrives unauthenticated
 * and the API answers 401. Correctly.
 *
 * That is not a new bug. The old print anchor sat on the patient screen from
 * Phase 1 and never once produced a document — it 401s every time. It looked
 * implemented, which is why nobody found it until a real 401 turned up in a
 * log. (The path is described rather than written out here: this file is
 * scanned by `endpoint-coverage.spec.ts`, and a path in a comment reads to it
 * as a call.)
 *
 * `client-nav.spec.ts` used to permit `/api/v1/...` anchors on the grounds
 * that they are "downloads that must leave the SPA". True of a genuinely
 * public download; false of every authenticated one, which is all of them
 * here — so that exemption is gone and the test now fails on any anchor to
 * the API.
 *
 * The file is fetched with the header attached, exactly as `api()` does, and
 * handed to the browser as a blob.
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
   * A month of referred work, for the laboratory to post to the hospital that
   * sent it. The `id` is the *referring hospital's* tenant, not a record of
   * ours, and the month travels as a query parameter — see `openDocument`.
   */
  | 'lab-statements';

/**
 * Fetches with the token, refreshing once on 401 like `api()` does.
 *
 * Not routed through `api()` itself: that helper parses the body as JSON or
 * text, and a PDF is neither. Duplicating the refresh dance is the smaller
 * evil against `api()` growing a response-type switch for one caller.
 */
async function fetchPdf(kind: DocumentKind, id: number, month?: StatementPeriod): Promise<Blob> {
  /*
   * The only document here that is about a *period* rather than a record.
   *
   * Appended to the one literal that needs it rather than threaded through
   * every branch, and empty when absent — the server then resolves "the current
   * month" in the hospital's own timezone, which is the only place that
   * question can be answered correctly.
   */
  const period =
    month?.from && month.to
      ? `?from=${encodeURIComponent(month.from)}&to=${encodeURIComponent(month.to)}`
      : '';

  /*
   * One literal URL per document, rather than one interpolated path.
   *
   * `fetch(url)` with `url` built elsewhere is shorter and invisible to
   * `endpoint-coverage.spec.ts`, which reads the literal at the call site — so
   * every one of these routes would have read as having no web caller, and the fix
   * available then would have been an exemption claiming the web does not call
   * them. That would be false, and a false reason in an exemption list is
   * worse than no list.
   */
  const get = (token: string | null) => {
    const init: RequestInit = {
      credentials: 'include',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    };
    if (kind === 'prescriptions') return fetch(`/api/v1/documents/prescriptions/${id}/pdf`, init);
    if (kind === 'invoices') return fetch(`/api/v1/documents/invoices/${id}/pdf`, init);
    if (kind === 'lab-orders') return fetch(`/api/v1/documents/lab-orders/${id}/pdf`, init);
    // A literal per document, for the reason above: `endpoint-coverage` reads
    // the literal at the call site, and an interpolated path is invisible to it.
    if (kind === 'specimen-labels')
      return fetch(`/api/v1/documents/lab-orders/${id}/labels`, init);
    if (kind === 'lab-statements')
      return fetch(`/api/v1/documents/lab-statements/${id}/pdf${period}`, init);
    return fetch(`/api/v1/documents/records/${id}/pdf`, init);
  };

  let res = await get(getAccessToken());

  // Access tokens last 15 minutes, so a 401 mid-session is ordinary.
  if (res.status === 401) {
    const fresh = await refreshAccessToken();
    if (fresh) res = await get(fresh);
  }

  if (!res.ok) {
    /*
     * The error body is JSON even though the success body is a PDF, so it is
     * read as text and surfaced. Without this the viewer opens on a blob of
     * JSON, which reads as a corrupt document rather than as a refusal — and
     * "you do not have permission" is a far more useful thing to see.
     */
    let detail = 'Could not produce that document';
    try {
      const body = (await res.json()) as { detail?: string; title?: string };
      detail = body.detail ?? body.title ?? detail;
    } catch {
      /* non-JSON error body; the status is all we have */
    }
    throw new ApiError(res.status, detail, detail);
  }

  return res.blob();
}

/**
 * Opens the document in a new tab.
 *
 * THE POPUP-BLOCKER DANCE, AND WHY IT IS NOT OPTIONAL
 * --------------------------------------------------
 * `window.open` is only allowed while the browser still considers itself
 * inside a user gesture. Awaiting the fetch first loses that, and the call is
 * blocked — silently, in most browsers, so the doctor clicks Print and nothing
 * whatsoever happens.
 *
 * So the tab is opened synchronously on the click, shows a holding message,
 * and is pointed at the blob once it arrives. If the fetch fails the tab is
 * closed again rather than left sitting on "Preparing…" forever.
 */
/**
 * Opens a file a technician uploaded, rather than one this system rendered.
 *
 * Same authentication problem and the same solution: the token is in memory and
 * travels as a header, so a link would arrive unauthenticated and 401. Kept
 * beside `openDocument` rather than folded into it because the routes differ
 * and `endpoint-coverage.spec.ts` reads the literal at the call site — one
 * function taking a path would make both invisible to it.
 *
 * The server decides whether the browser may render it in place. A PDF comes
 * back `inline`; a Word document comes back `attachment` with `nosniff`, so the
 * browser downloads it instead of guessing. Nothing here overrides that.
 */
export async function openLabAttachment(
  id: number,
): Promise<{ ok: boolean; message?: string }> {
  const tab = window.open('', '_blank');
  if (tab) {
    tab.document.write(
      '<title>Opening…</title><body style="font:14px system-ui;padding:2rem;color:#555">Opening the file…</body>',
    );
  }

  try {
    const get = (token: string | null) =>
      fetch(`/api/v1/lab/attachments/${id}/file`, {
        credentials: 'include',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });

    let res = await get(getAccessToken());
    if (res.status === 401) {
      const fresh = await refreshAccessToken();
      if (fresh) res = await get(fresh);
    }

    if (!res.ok) {
      let detail = 'Could not open that file';
      try {
        const body = (await res.json()) as { detail?: string; title?: string };
        detail = body.detail ?? body.title ?? detail;
      } catch {
        /* non-JSON error body; the status is all we have */
      }
      throw new ApiError(res.status, detail, detail);
    }

    /*
     * The blob keeps the server's content type, so a Word document opens in
     * whatever the browser does with one rather than being rendered as text.
     */
    const objectUrl = URL.createObjectURL(await res.blob());
    if (tab) tab.location.href = objectUrl;
    else {
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = `attachment-${id}`;
      a.click();
    }
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    return { ok: true };
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Could not produce that document';

    if (tab) {
      /*
       * Written into the tab rather than closing it. A tab that opens and
       * vanishes reads as the button being broken; one that says why reads as
       * an answer — and for the commonest refusals here ("not authorised yet")
       * the answer is the whole point.
       *
       * `textContent` on a fresh element rather than interpolation, because
       * this string comes from the API and a document renderer is the last
       * place to start writing unescaped HTML.
       */
      tab.document.body.innerHTML = '';
      const p = tab.document.createElement('p');
      p.setAttribute('style', 'font:14px system-ui;padding:2rem;color:#8a2a1f');
      p.textContent = message;
      tab.document.body.appendChild(p);
      tab.document.title = 'Not available';
    }

    return { ok: false, message };
  }
}

/**
 * Send a file up.
 *
 * `FormData` rather than base64 in JSON: a third smaller on the wire, and the
 * size limit lives on the one route that needs it instead of the global body
 * parser. The `Content-Type` header is deliberately NOT set — the browser has
 * to add its own multipart boundary, and setting it by hand produces a request
 * the server cannot parse.
 */
export async function uploadLabAttachment(
  itemId: number,
  file: File,
  meta: { kind?: string; description?: string } = {},
): Promise<void> {
  const body = new FormData();
  body.append('file', file);
  if (meta.kind) body.append('kind', meta.kind);
  if (meta.description) body.append('description', meta.description);

  const send = (token: string | null) =>
    fetch(`/api/v1/lab/items/${itemId}/attachments`, {
      method: 'POST',
      credentials: 'include',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body,
    });

  let res = await send(getAccessToken());
  if (res.status === 401) {
    const fresh = await refreshAccessToken();
    if (fresh) res = await send(fresh);
  }

  if (!res.ok) {
    /*
     * The server's refusal, verbatim. It says which file and why — "that is a
     * JPG", "that is 14.2 MB, the limit is 10 MB" — and paraphrasing it as
     * "upload failed" would throw away the only part a technician can act on.
     */
    let detail = 'Could not attach that file';
    try {
      const parsed = (await res.json()) as { detail?: string; title?: string };
      detail = parsed.detail ?? parsed.title ?? detail;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, detail, detail);
  }
}

/**
 * Open a document, and **never throw**.
 *
 * THE BUG THIS FIXES
 * ------------------
 * This used to rethrow, and every call site in the app invokes it as `void
 * openDocument(...)`. So a refusal from the API — "that report has not been
 * authorised yet", "nothing on that order needs a specimen" — became an
 * unhandled promise rejection: a red overlay in development pointing at the
 * `throw` inside `fetchPdf`, and in production a tab that closed with nothing
 * said at all.
 *
 * The reason was already in hand. `fetchPdf` deliberately reads the JSON error
 * body and puts the server's own sentence in `detail`, precisely so somebody
 * can be told why — and then nothing showed it. That is the shape this project
 * keeps recording: the API refusing correctly and unexplainably.
 *
 * The message now goes into the tab that was already opened saying "Preparing
 * the document…", which every existing `void` call site gets for free without
 * remembering to catch. The boolean is for callers that need to know — the
 * worklist only refetches when a print actually succeeded, because printing a
 * label can allocate a specimen number.
 */
export async function openDocument(
  kind: DocumentKind,
  id: number,
  /** Only `lab-statements` uses it: the period being billed. */
  month?: StatementPeriod,
): Promise<{ ok: boolean; message?: string }> {
  const tab = window.open('', '_blank');
  if (tab) {
    tab.document.write(
      '<title>Preparing…</title><body style="font:14px system-ui;padding:2rem;color:#555">Preparing the document…</body>',
    );
  }

  try {
    const blob = await fetchPdf(kind, id, month);
    const objectUrl = URL.createObjectURL(blob);

    if (tab) {
      tab.location.href = objectUrl;
    } else {
      // The popup was blocked before we ever got here. Fall back to a download
      // in this tab, which needs no gesture — worse than a preview, and far
      // better than nothing happening.
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = `${kind}-${id}.pdf`;
      a.click();
    }

    /*
     * Released after a delay rather than immediately: revoking while the tab
     * is still loading the blob leaves it on a blank page. Sixty seconds is
     * long enough for a viewer to read it and short enough that a shift's
     * worth of prints does not accumulate in memory.
     */
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    return { ok: true };
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Could not produce that document';

    if (tab) {
      // Written into the tab rather than closing it — see the note above.
      tab.document.body.innerHTML = '';
      const p = tab.document.createElement('p');
      p.setAttribute('style', 'font:14px system-ui;padding:2rem;color:#8a2a1f');
      p.textContent = message;
      tab.document.body.appendChild(p);
      tab.document.title = 'Not available';
    }

    return { ok: false, message };
  }
}
