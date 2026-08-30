import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Every endpoint should have a caller, or say why not.
 *
 * WHY THIS EXISTS
 * ---------------
 * Phase 3 shipped `POST /admissions`, `PATCH /admissions/:id/discharge` and
 * `POST /admissions/:id/medication-schedule` — all tested, all correct, all
 * reachable by nobody. There was no way to admit a patient except by seeding
 * the database, and a newly admitted patient's drug chart stayed empty
 * forever. Every unit test passed the whole time.
 *
 * That is the failure mode this catches: a backend that is complete on its own
 * terms and unusable from a client. Nothing in a typechecker or a unit test
 * notices, because from the API's point of view nothing is wrong.
 *
 * HOW IT MATCHES, AND WHY IT WAS REWRITTEN
 * ----------------------------------------
 * The first version checked that each fixed segment of a route appeared
 * *somewhere* in the concatenated client source. That is much weaker than it
 * reads. `PATCH /users/:id/roles` passed on the coincidence of the words
 * "users" and "roles" appearing in unrelated places — it was green before any
 * role-switching UI existed. Segments did not have to be adjacent, in order, in
 * the same URL, or even in the same file, and the HTTP method was ignored
 * entirely, so a `GET` route was satisfied by a `POST` to the same path.
 *
 * It now extracts the actual `(method, path)` pairs the clients issue and
 * matches structurally: same verb, same segment count, fixed segments equal in
 * position, parameters aligned. Tightening it found six endpoints that had been
 * passing on coincidence, four of which were genuine missing UI.
 *
 * Three call styles count as callers, because all three really do reach the
 * API — missing any of them would produce false orphans:
 *   - `api('/path', { method })` and `fetch('.../api/v1/path')`
 *   - `{ path: '/x', method: 'POST' }` — mobile's offline outbox, which queues
 *     a request now and replays it later
 *   - `<a href={`/api/v1/...`}>` — browser navigation, e.g. the print view
 */

const BACKEND_SRC = path.resolve(__dirname, '../..');
const REPO_ROOT = path.resolve(BACKEND_SRC, '../..');
const CLIENT_DIRS = ['web/app', 'web/lib', 'web/components', 'mobile/app', 'mobile/lib', 'mobile/components'];

/**
 * Endpoints with no client caller *on purpose* — a design decision, not a
 * backlog item. These are expected to stay here.
 */
const INTENTIONALLY_UNCALLED: Record<string, string> = {
  'GET /health': 'Infrastructure probe, not a client feature.',
  'GET /admissions/:id': 'Ward board carries the admission inline; no client needs to fetch one alone yet.',
  'GET /doctors/:id': 'Clients use the directory list; nothing needs a single doctor yet.',
  // 'GET /appointments/:id' was exempted here on the argument that reschedule
  // already held the row it was editing. Mobile reschedule is a route reached
  // by id with no row in hand, so it fetches one — the exemption's reasoning
  // was true of the web app and never of a deep-linkable screen.
  'GET /prescriptions/:id':
    'Superseded by GET /pharmacy/prescriptions/:id, which returns the same prescription plus stock and allergy context. The plain read is kept for a non-pharmacy caller that does not exist yet.',
};

/**
 * Missing UI, not design decisions.
 *
 * Separate from the list above because the two mean opposite things and lumping
 * them together is how a gap becomes permanent: a reader skims one list of
 * "fine, ignore these" and the real holes disappear into it. This list is
 * expected to *shrink*, and a test below fails if an entry is not also written
 * down in PLAN.md — so nothing can be parked here quietly.
 *
 * All four were found the day the matching was tightened; every one of them had
 * been passing on a coincidental substring hit.
 */
const KNOWN_GAPS: Record<string, string> = {
  'GET /patients/:patientId/admissions':
    'No screen shows a past stay. Admission history UI was never built.',
  'POST /medicines':
    'The catalogue can only be seeded. There is no way to add a medicine through the UI.',
  'PATCH /medicines/:id':
    'No way to correct a catalogue entry — which is what the drugClass=OTHER trap in CLAUDE.md needs to be fixable.',
  'PATCH /prescriptions/:id/cancel':
    'A doctor who prescribes the wrong thing cannot retract it. The UI already reasons about cancelled prescriptions (schedule-medication-sheet refuses to chart one) but offers no way to cancel.',
};

/**
 * The vendor platform API is exempt as a *category*, and for the opposite
 * reason to the list above.
 *
 * Those endpoints have no caller yet. These must never have one here: a
 * hospital client that could call `/platform/...` would be a defect, not a
 * feature. The console that drives them is a separate vendor-side surface with
 * its own deployment and its own credentials.
 *
 * So this is not a hole in the check — the inverse is asserted below, and a
 * `/platform` string appearing anywhere in web/ or mobile/ fails the build.
 */
const PLATFORM_PREFIX = '/platform/';

interface Endpoint {
  method: string;
  routePath: string;
  file: string;
}

function walk(dir: string, match: RegExp): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry === '.expo') continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, match));
    else if (match.test(entry)) out.push(full);
  }
  return out;
}

/** Reads @Controller('x') and the @Get/@Post/... decorators beneath it. */
function endpointsIn(file: string): Endpoint[] {
  const src = readFileSync(file, 'utf8');
  const found: Endpoint[] = [];

  // A file may hold more than one controller (vitals, medications).
  const controllerBlocks = [...src.matchAll(/@Controller\((?:'([^']*)')?\)/g)];

  for (const [i, block] of controllerBlocks.entries()) {
    const start = block.index ?? 0;
    const end = controllerBlocks[i + 1]?.index ?? src.length;
    const base = block[1] ?? '';
    const body = src.slice(start, end);

    for (const m of body.matchAll(/@(Get|Post|Patch|Put|Delete)\((?:'([^']*)')?\)/g)) {
      const method = m[1].toUpperCase();
      const sub = m[2] ?? '';
      const routePath = `/${[base, sub].filter(Boolean).join('/')}`.replace(/\/+/g, '/');
      found.push({ method, routePath, file: path.relative(BACKEND_SRC, file) });
    }
  }
  return found;
}

interface ClientCall {
  method: string;
  path: string;
}

/**
 * Reads a string or template literal starting at `open`.
 *
 * Interpolations collapse to a literal `${}` marker rather than being skipped,
 * so `/patients/${id}/vitals` keeps its shape. Scanning rather than regex
 * matters: a template can contain quotes inside `${...}` — the inventory page
 * has `${q ? '?lowStock=1' : ''}` — and a regex terminating on the first quote
 * truncates the path.
 */
function readLiteral(src: string, open: number): { raw: string; end: number } | null {
  const quote = src[open];
  if (quote !== "'" && quote !== '"' && quote !== '`') return null;

  let out = '';
  let i = open + 1;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') {
      out += src[i + 1];
      i += 2;
      continue;
    }
    if (c === quote) return { raw: out, end: i };
    if (quote === '`' && c === '$' && src[i + 1] === '{') {
      let depth = 1;
      i += 2;
      while (i < src.length && depth > 0) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') depth--;
        i++;
      }
      out += '${}';
      continue;
    }
    out += c;
    i++;
  }
  return null;
}

/** Steps over `<Paginated<PatientListItem>>` in `api<T>(...)`. Nesting counts. */
function skipGenerics(src: string, from: number): number {
  let i = from;
  while (i < src.length && /\s/.test(src[i])) i++;
  if (src[i] !== '<') return i;

  let depth = 0;
  while (i < src.length) {
    if (src[i] === '<') depth++;
    else if (src[i] === '>') {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return i;
}

/**
 * The rest of this call's arguments, so `method:` is read from the right one.
 *
 * A fixed lookahead window was the first attempt and it read the *next* call's
 * method — `/auth/me` came out as a POST because a nearby call was one.
 */
function callArguments(src: string, from: number): string {
  let depth = 1;
  let i = from;
  while (i < src.length && depth > 0) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') depth--;
    i++;
  }
  return src.slice(from, i);
}

function clientCallsIn(src: string): ClientCall[] {
  const out: ClientCall[] = [];

  const record = (literal: string, rest: string) => {
    const p = literal.split('?')[0];
    // A path built entirely from a variable tells us nothing; skip rather than
    // guess, and accept the false orphan if one ever appears.
    if (!p.startsWith('/')) return;
    const m = /\bmethod:\s*['"]([A-Za-z]+)['"]/.exec(rest);
    out.push({ method: (m ? m[1] : 'GET').toUpperCase(), path: p });
  };

  // api('/x', { method }) and api<T>('/x', { method })
  for (const m of src.matchAll(/\bapi\b/g)) {
    let i = skipGenerics(src, m.index + 3);
    while (i < src.length && /\s/.test(src[i])) i++;
    if (src[i] !== '(') continue;
    i++;
    while (i < src.length && /\s/.test(src[i])) i++;
    const lit = readLiteral(src, i);
    if (lit) record(lit.raw, callArguments(src, lit.end + 1));
  }

  // The auth helpers call fetch directly, before a token exists.
  for (const m of src.matchAll(/\bfetch\(\s*/g)) {
    const lit = readLiteral(src, m.index + m[0].length);
    if (!lit) continue;
    const at = lit.raw.indexOf('/api/v1');
    if (at < 0) continue;
    record(lit.raw.slice(at + '/api/v1'.length), callArguments(src, lit.end + 1));
  }

  // Mobile's offline outbox: { path: '/vitals', method: 'POST' }. A real
  // caller that never touches api(), because the request is queued now and
  // replayed when signal returns. Missing these reported bedside vitals and
  // the medication round as orphans.
  for (const m of src.matchAll(/\bpath:\s*/g)) {
    const lit = readLiteral(src, m.index + m[0].length);
    if (lit) record(lit.raw, src.slice(lit.end, lit.end + 200));
  }

  // <a href={`/api/v1/prescriptions/${id}/print`}> — a GET the browser issues
  // by navigation. No fetch call exists for it and it is still a caller.
  for (const m of src.matchAll(/href=\{?\s*/g)) {
    const lit = readLiteral(src, m.index + m[0].length);
    if (!lit) continue;
    const at = lit.raw.indexOf('/api/v1');
    if (at < 0) continue;
    record(lit.raw.slice(at + '/api/v1'.length), '');
  }

  return out;
}

/**
 * Normalises a path to `METHOD /a/:p/b` so both sides compare structurally.
 *
 * A whole segment that is an interpolation or a bare number is a parameter. An
 * interpolation *inside* a larger segment is text — a query string glued on,
 * like `/pharmacy/inventory${q}` — so it is stripped rather than treated as one.
 */
function shapeOf(method: string, routePath: string): string {
  const segments = routePath
    .split('/')
    .filter(Boolean)
    .map((s) => (s === '${}' || s.startsWith(':') || /^\d+$/.test(s) ? ':p' : s.replace(/\$\{\}/g, '')));
  return `${method} /${segments.join('/')}`;
}

describe('endpoint coverage', () => {
  const controllerFiles = walk(BACKEND_SRC, /\.controller\.ts$/);
  const endpoints = controllerFiles.flatMap(endpointsIn);

  const clientFiles = CLIENT_DIRS.flatMap((d) => walk(path.join(REPO_ROOT, d), /\.tsx?$/)).filter(
    (f) => !/\.test\.tsx?$/.test(f),
  );
  const clientSource = clientFiles.map((f) => readFileSync(f, 'utf8')).join('\n');
  const clientCalls = clientFiles.flatMap((f) => clientCallsIn(readFileSync(f, 'utf8')));
  const calledShapes = new Set(clientCalls.map((c) => shapeOf(c.method, c.path)));

  it('finds the controllers', () => {
    expect(controllerFiles.length).toBeGreaterThan(5);
    expect(endpoints.length).toBeGreaterThan(20);
  });

  it('finds the client source to search', () => {
    // Guards against the whole suite passing vacuously because the relative
    // path to web/ or mobile/ went stale.
    expect(clientSource.length).toBeGreaterThan(10_000);
    expect(clientSource).toContain('/auth/login');
  });

  it('extracts real calls rather than matching stray words', () => {
    /*
     * The guard on the guard. If the extractor silently stopped working, every
     * endpoint would look orphaned — noisy and obvious — but if it half-worked
     * the exemption lists would quietly grow to cover its blind spots.
     *
     * These four assert the parsing cases that were actually wrong at some
     * point while writing it.
     */
    expect(clientCalls.length).toBeGreaterThan(50);
    // Nested generics: api<Paginated<PatientListItem>>('/patients?q=…')
    expect(calledShapes.has('GET /patients')).toBe(true);
    // The outbox, which never calls api()
    expect(calledShapes.has('POST /vitals')).toBe(true);
    // Method read from the right call, not a neighbouring one
    expect(calledShapes.has('GET /auth/me')).toBe(true);
  });

  it('never claims a call to an endpoint that does not exist', () => {
    // The other direction, and it costs nothing to check: a client path that
    // matches no route is a typo or a route that was renamed out from under it.
    // Either way the request 404s at runtime and nothing else would say so.
    const routeShapes = new Set(endpoints.map((e) => shapeOf(e.method, e.routePath)));
    const dangling = [...calledShapes].filter((s) => !routeShapes.has(s)).sort();
    expect(dangling).toEqual([]);
  });

  it('has a caller for every endpoint, or a stated reason', () => {
    const orphans: string[] = [];

    for (const ep of endpoints) {
      const key = `${ep.method} ${ep.routePath}`;
      if (key in INTENTIONALLY_UNCALLED || key in KNOWN_GAPS) continue;
      if (ep.routePath.startsWith(PLATFORM_PREFIX)) continue;

      // Same verb, same segment count, fixed segments equal in position.
      if (!calledShapes.has(shapeOf(ep.method, ep.routePath))) {
        orphans.push(`${key}  (${ep.file})`);
      }
    }

    expect(orphans).toEqual([]);
  });

  it('writes every known gap down in PLAN.md', () => {
    /*
     * What stops KNOWN_GAPS becoming a junk drawer.
     *
     * An exemption list is only honest if the things on it are visible
     * somewhere a person actually reads. PLAN.md is that place; this test is
     * what makes adding an entry here cost the same as admitting it there.
     */
    const plan = readFileSync(path.join(REPO_ROOT, 'PLAN.md'), 'utf8');
    const undocumented = Object.keys(KNOWN_GAPS).filter((k) => !plan.includes(k));
    expect(undocumented).toEqual([]);
  });

  it('keeps the two exemption lists from overlapping', () => {
    // A route in both would be a design decision and a gap at once, which is
    // the ambiguity splitting them was meant to remove.
    const both = Object.keys(KNOWN_GAPS).filter((k) => k in INTENTIONALLY_UNCALLED);
    expect(both).toEqual([]);
  });

  it('keeps the platform API out of the hospital clients entirely', () => {
    /*
     * The inverse of the exemption above, and the reason it is allowed to be a
     * category rather than a list.
     *
     * A vendor endpoint reachable from the hospital web app is a much worse
     * defect than an endpoint with no caller: it would put break-glass and the
     * cross-hospital tenant list on the surface every receptionist loads. The
     * clients have no business knowing this API exists.
     */
    const platformEndpoints = endpoints.filter((e) => e.routePath.startsWith(PLATFORM_PREFIX));
    expect(platformEndpoints.length).toBeGreaterThan(0);

    expect(clientSource).not.toContain('/platform');
    expect(clientSource).not.toContain('break-glass');
  });

  it('does not carry stale entries in the exemption list', () => {
    // An exemption for an endpoint that no longer exists is a lie the next
    // person will trust.
    const live = new Set(endpoints.map((e) => `${e.method} ${e.routePath}`));
    const stale = [...Object.keys(INTENTIONALLY_UNCALLED), ...Object.keys(KNOWN_GAPS)].filter(
      (k) => !live.has(k),
    );
    expect(stale).toEqual([]);
  });

  it('drops an exemption as soon as the endpoint gains a caller', () => {
    /*
     * The list must shrink on its own, or it rots into a set of claims nobody
     * rechecks. Tightening the matching already made one entry stale —
     * `POST /auth/logout` was listed as "called through a dedicated helper",
     * and the helper is a call like any other once you parse instead of grep.
     */
    const nowCalled = [...Object.keys(INTENTIONALLY_UNCALLED), ...Object.keys(KNOWN_GAPS)].filter(
      (k) => {
        const ep = endpoints.find((e) => `${e.method} ${e.routePath}` === k);
        return ep && calledShapes.has(shapeOf(ep.method, ep.routePath));
      },
    );
    expect(nowCalled).toEqual([]);
  });

  it('gives every exemption a real reason', () => {
    // "TODO" or an empty string would let anything through.
    const unexplained = [
      ...Object.entries(INTENTIONALLY_UNCALLED),
      ...Object.entries(KNOWN_GAPS),
    ]
      .filter(([, reason]) => reason.trim().length < 20)
      .map(([key]) => key);
    expect(unexplained).toEqual([]);
  });
});
