import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * A refused document has to say why, on screen.
 *
 * THE BUG THIS EXISTS FOR
 * -----------------------
 * `openDocument` rethrew, and every call site in the web app invokes it as
 * `void openDocument(...)`. So a perfectly correct refusal from the API — "that
 * report has not been authorised yet", "nothing on that order needs a
 * specimen" — became an **unhandled promise rejection**: a red overlay in
 * development pointing at the `throw` inside `fetchPdf`, and in production a
 * tab that opened and closed with nothing said.
 *
 * The reason was already in hand the whole time. `fetchPdf` deliberately reads
 * the JSON error body and puts the server's own sentence into the thrown error,
 * *precisely so somebody can be told* — and then nothing displayed it. That is
 * the shape this project keeps recording: the API refusing correctly and
 * unexplainably, and the person who meets it having no idea what to do.
 *
 * WHAT IS ASSERTED
 * ----------------
 * That the two web helpers resolve rather than throw. Nothing here checks the
 * wording, because the wording comes from the API and belongs there; what
 * matters is that a `void` call site cannot turn a refusal into silence.
 */

const ROOT = path.resolve(__dirname, '../../../..');
const DOCUMENTS = readFileSync(path.join(ROOT, 'web/lib/documents.ts'), 'utf8');

/** Comments first — a `throw` inside a doc comment is not a `throw`. */
function strip(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** One exported function's body, sliced to the next top-level declaration. */
function body(name: string): string {
  const src = strip(DOCUMENTS);
  const at = src.indexOf(`export async function ${name}`);
  expect(at).toBeGreaterThanOrEqual(0);

  const rest = src.slice(at);
  const next = rest.slice(1).search(/\nexport (?:async )?function /);
  return next === -1 ? rest : rest.slice(0, next);
}

describe('opening a document never throws at the caller', () => {
  it.each([['openDocument'], ['openLabAttachment']])('%s resolves instead', (name) => {
    const fn = body(name);

    /*
     * `throw e` **in the catch** is the exact regression. A caller writing
     * `void openDocument(...)` — which is every one of them — cannot catch it,
     * and the browser reports it as an unhandled rejection rather than as the
     * refusal it is.
     *
     * Scoped to the catch rather than the whole function, which was the first
     * version and failed: both helpers throw *internally* on a bad response so
     * their own `try` can handle it in one place. That throw is the mechanism,
     * not the bug — the bug is letting it escape.
     */
    const caught = fn.slice(fn.indexOf('} catch (e) {'));
    expect(caught).not.toBe('');
    expect(caught).not.toMatch(/\bthrow\b/);
    expect(fn).toMatch(/return \{ ok: false/);
    expect(fn).toMatch(/return \{ ok: true \}/);
  });

  it('still tells somebody, rather than failing quietly', () => {
    /*
     * The other half, and the more tempting mistake: making the throw go away
     * by swallowing it. A button that does nothing is worse than one that
     * explodes, because at least an explosion gets reported.
     *
     * The message is written into the tab that was already opened saying
     * "Preparing the document…", so every existing `void` call site shows it
     * without having to remember to catch.
     */
    for (const name of ['openDocument', 'openLabAttachment']) {
      expect(body(name)).toMatch(/textContent = message/);
    }
  });

  it('escapes it, because the string comes from the API', () => {
    // A document renderer is the last place to start writing unescaped HTML.
    expect(DOCUMENTS).not.toMatch(/innerHTML\s*=\s*`/);
    expect(DOCUMENTS).not.toMatch(/innerHTML\s*=\s*[^'"]*\$\{/);
  });
});
