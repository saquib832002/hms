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
  /*
   * Called by the server, not by a client.
   *
   * Reporting a referral back used to be a form on the incoming queue, which
   * skipped specimen acceptance, the bench and authorisation — "nothing is a
   * result until it is verified" held for a hospital's own orders and not for
   * work it performed for anybody else. Accepting now raises a real order and
   * `LabService.verify` transmits when it is authorised, so this route has no
   * client caller by design. One appearing again would mean the gate had been
   * stepped around.
   */
  'POST /lab/referrals/:id/result':
    'Invoked by LabService.verify when a referred order is authorised, so a referred report passes the same two-step gate as a local one.',
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
  // 'GET /patients/:patientId/admissions' was here for want of a screen. The
  // observation plan needs to know which stay a patient is on, so the vitals
  // screen resolves it — the entry went the way this list is supposed to go.
  // 'POST /medicines' and 'PATCH /medicines/:id' were here for six phases and
  // are now closed. The consequence only became visible on a real deployment:
  // a hospital that did not run the demo seed had an empty catalogue, so
  // "receive stock" offered nothing to receive against and the pharmacy did not
  // work at all — with nothing on screen explaining why.
  // 'PATCH /prescriptions/:id/cancel' was the most serious entry on this list
  // and is now closed. A doctor who prescribed the wrong thing could not
  // retract it, while `schedule-medication-sheet` already refused to chart a
  // cancelled prescription — the UI reasoned about a state nothing could reach.
};

/**
 * The vendor platform API is exempt as a *category*, and for the opposite
 * reason to the list above.
 *
 * Those endpoints have no caller yet. These are called only by the vendor
 * console, which lives at `web/app/(platform)` and is a different application
 * wearing the same deployment: its own login, its own token audience, and a
 * guard that sets no `req.user` so a hospital token cannot reach it.
 *
 * So this is not a hole in the check. Two assertions below replace what used to
 * be an outright ban on the string `/platform`: only the console's own files
 * may name the vendor API, and the console may call nothing else.
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

/** The first top-level argument of a call — everything before the first comma
 *  that is not inside brackets, braces, parentheses or a string. */
function splitTopLevel(args: string): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const c = args[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ',' && depth === 0) return args.slice(0, i);
  }
  return args;
}

/**
 * Every path literal in a fragment of source, normalised the same way
 * `readLiteral` normalises the simple case.
 *
 * Two subtleties, both found by this test failing:
 *
 * 1. Interpolations must collapse to the `${}` marker, or
 *    `/billing/invoices/${id}` is compared verbatim against `/billing/
 *    invoices/:id` and never matches. Reusing `readLiteral` rather than a
 *    regex is what gets that right.
 *
 * 2. A literal that is an operand of `===` is a *discriminator*, not a route.
 *    `basePath === '/pharmacy' ? ... : ...` would otherwise record a call to
 *    `GET /pharmacy`, which no controller serves — a phantom caller, and the
 *    mirror image of the false orphan this whole branch exists to prevent.
 */
function pathLiteralsIn(fragment: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < fragment.length; i++) {
    const c = fragment[i];
    if (c !== "'" && c !== '"' && c !== '`') continue;

    const before = fragment.slice(0, i).trimEnd();
    const isComparison = /[=!]==?$/.test(before);

    const lit = readLiteral(fragment, i);
    if (!lit) continue;
    if (!isComparison && lit.raw.startsWith('/')) out.push(lit.raw);
    i = lit.end;
  }
  return out;
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
    if (lit) {
      record(lit.raw, callArguments(src, lit.end + 1));
      continue;
    }

    /*
     * The path is not a literal at this position — it is chosen.
     *
     *   api(base === '/pharmacy' ? '/pharmacy/invoices' : '/billing/invoices')
     *
     * That call style arrived with the pharmacy till: the invoice ledger is one
     * screen serving two sets of books, so the same component calls two
     * different routes. Reading only the first token reported all six of those
     * routes as having no caller, which is a **false orphan** — and the way an
     * exemption list quietly grows to paper over a broken extractor. That
     * failure has happened here once already, when matching on loose path
     * fragments passed five real gaps on coincidence.
     *
     * So: every path-shaped literal in the first argument counts. Still scoped
     * to the argument, not the whole call, so `{ method: 'POST' }` and a body
     * containing a string cannot be mistaken for a route.
     */
    const args = callArguments(src, i);
    const firstArg = splitTopLevel(args);
    for (const raw of pathLiteralsIn(firstArg)) record(raw, args);
  }

  /*
   * `fetch(...)`, and `FileSystem.downloadAsync(...)` which has the same shape.
   *
   * The auth helpers call fetch directly, before a token exists. The phone
   * downloads a PDF the same way: the response is a binary file written to the
   * cache directory, and the token must travel as a header rather than in the
   * URL — `AuditInterceptor` records the path, so a credential there would land
   * in the audit table.
   *
   * Added for the same reason as the outbox and the bare anchor below: it
   * really does reach the API. The alternative was a `MOBILE_ONLY` exemption
   * claiming the phone does not call those routes, which would have been false,
   * and a false reason in an exemption list is worse than no list.
   */
  for (const m of src.matchAll(/\b(?:fetch|downloadAsync)\(\s*/g)) {
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

  /** The same extraction, but keeping track of which client made the call. */
  const shapesFor = (client: 'web' | 'mobile') =>
    new Set(
      clientFiles
        .filter((f) => f.includes(`${path.sep}${client}${path.sep}`))
        .flatMap((f) => clientCallsIn(readFileSync(f, 'utf8')))
        .map((c) => shapeOf(c.method, c.path)),
    );

  const webShapes = shapesFor('web');
  const mobileShapes = shapesFor('mobile');

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

  /*
   * ═══════════════════════════════════════════════════════════════════════
   * PARITY: "some client calls it" is a weaker claim than it reads as
   * ═══════════════════════════════════════════════════════════════════════
   *
   * Everything above asks whether *a* client calls a route. That is the wrong
   * question when two clients serve the same role, and it let a real gap
   * through for a whole phase.
   *
   * `POST /appointments/:id/invoice` — the charge reception raises at check-in
   * — was built, tested, and wired into the mobile schedule screen. The web
   * check-in screen, which is where reception actually works most of the day,
   * never called it. Coverage was green throughout, because mobile counted.
   *
   * The symptom was a receptionist checking a patient in on the web and being
   * offered no way to bill them, while the same action on a phone worked. A
   * user reported it; no test could.
   *
   * So parity is asserted per client, for the routes a role needs on both. The
   * exemption list is the interesting part: mobile is deliberately a curated
   * subset — invoice aging and the audit browser are scanning tasks a phone is
   * bad at — so a blanket "both clients call everything" would be false and
   * would be silenced by exempting half the API. Each entry names the route and
   * the reason, which is what stops an omission acquiring a rationale.
   */
  /** Routes only the web app calls, because a phone is the wrong tool. */
  const WEB_ONLY: Record<string, string> = {
    'POST /admissions': 'Bed management from a desk; the ward board on mobile is read plus care.',
    'PATCH /admissions/:p/transfer': 'As above — moving a patient between beds is a desk action.',
    'PATCH /admissions/:p/discharge': 'As above.',
    'POST /admissions/:p/medication-schedule': 'Charting a regimen is multi-field data entry.',
    'GET /billing/invoices/:p': 'Mobile pays from the list; the itemised invoice is a reading screen.',
    'GET /pharmacy/invoices/:p':
      'Same as the billing one above — the mobile till expands a row it already holds, and the itemised receipt is a reading screen.',
    'GET /lab/invoices/:p':
      'Same as the two above — the mobile till expands a row it already holds, and the itemised charge is a reading screen.',
    /*
     * The test catalogue and the partner directory: configuration a hospital
     * sets up once, at a desk.
     *
     * `POST /lab-tests` carries reference ranges, critical thresholds and a
     * price per analyte — a form somebody fills in with a laboratory handbook
     * open beside them, not a task during a shift. The same line departments,
     * staff accounts, tax rates and ward layout sit on.
     *
     * NOT the reason: "nobody has built it yet". The lab's *use* of the
     * catalogue is on both clients, and so is fixing a missing price —
     * `PATCH /lab-tests/:p` is deliberately absent from this list, because an
     * unpriced test is discovered mid-shift and sending the technician to a
     * screen they cannot reach is how the pharmacy ended up dispensing
     * medicine unbilled for a month.
     */
    /*
    /*
     * Ward and bed setup, all seven routes.
     *
     * The same line departments and staff accounts sit on: a hospital lays its
     * wards out once, at a desk, before anyone uses the system — it is not a
     * task somebody does standing up, and mobile admin is read-only with three
     * stated exceptions, none of which this resembles.
     *
     * Worth stating what is NOT the reason. This is not "nobody has built it
     * yet" — that would make it a PARITY_GAP. The nurse's *use* of wards is on
     * both clients and always was; only the one-off configuration is here.
     */
    'GET /wards/setup': 'Ward layout is configured once at a desk, like departments.',
    'POST /wards': 'As above — creating a ward is setup, not a task during a shift.',
    'PATCH /wards/:p': 'As above.',
    'DELETE /wards/:p': 'As above, and destructive: it is refused once any bed has been used.',
    'POST /wards/:p/beds': 'As above — bulk bed creation is a numeric form, not a phone task.',
    'PATCH /wards/beds/:p':
      'Renaming a bed or taking it out of service is estate management. The clinical consequence of a closed bed — that nobody can be admitted to it — is already visible on both ward boards.',
    'DELETE /wards/beds/:p': 'As above, and refused for any bed that has ever held a patient.',
    'GET /patients/:p/vitals': 'Mobile records vitals at the bedside; the history chart is web.',
    'GET /letterhead':
      'Setting up what the hospital prints is a one-off desk task, on the same line as departments and staff accounts — done once with the letterhead in front of you. The phone consumes the result (it shares the PDF) and does not configure it.',
    'PATCH /letterhead': 'As above.',
    'GET /patients/:p/admissions':
      'Only the web needs to look a stay up: the mobile bedside form is reached from the ward board, which already holds the admission id and passes it through.',
    // 'GET /medicines' was listed here as web-only on the argument that mobile
    // reads the catalogue through /pharmacy/inventory. True of the stock
    // screen, and it stopped being true the moment prescribing gained a
    // type-ahead: a doctor needs the catalogue and has no business fetching
    // stock levels to get it.
    // 'PATCH /medicines/:p' was here on the argument that correcting a
    // medicine — usually a wrong drug class — is a considered edit at a desk.
    // That held while the only caller was the catalogue editor. It stopped
    // holding when dispensing gained an inline price: an unpriced medicine is
    // discovered mid-dispense with a patient at the counter, and sending the
    // pharmacist to another screen meant the medicine went out unpriced and
    // the money was lost quietly. Setting a price is not the same kind of edit
    // as reclassifying a drug, and the phone is exactly where it happens.
    /*
     * Tax configuration is a desk task, like departments and staff accounts.
     *
     * Setting a rate is an accounting decision taken once, with the hospital's
     * figures to hand — not something done at a counter or a bedside, and
     * getting it wrong misprices every subsequent sale.
     *
     * Mobile deliberately does not need the rate *table*: the server computes
     * the tax and sends the amounts on the charge and the invoice, so a phone
     * shows what was charged without holding the rules that produced it. That
     * is the same split as pricing — the phone can correct one price inline,
     * and does not carry the catalogue editor.
     */
    'GET /tax-rates': 'Configuration screen. Mobile shows tax amounts the server computed, never the rate table.',
    'POST /tax-rates': 'As above — an accounting decision taken at a desk.',
    'PATCH /tax-rates/:p': 'As above. Changing a rate misprices every later sale, so it is not a one-handed task.',
    'DELETE /tax-rates/:p': 'As above.',
    'GET /medicines/unmapped': 'The free-text-to-catalogue mapping tool is a pharmacy desk job.',
    'PATCH /medicines/items/:p/link': 'As above.',
    'PATCH /patients/:p': 'Mobile registers patients; correcting demographics is a desk task.',
    // `GET /pharmacy/prescriptions/:p` and the dispense POST were here, on the
    // reasoning that dispensing is "checked against stock at a counter". That
    // is where it happens, and it is also where somebody is holding a phone —
    // the pharmacist is at the shelf with the box, not at a terminal. What the
    // exemption really described was a queue screen that listed work and then
    // told you to go to the web app, which is a worse screen than none.
    'GET /pharmacy/history': 'A reconciliation list.',
    'GET /prescriptions/:p/print': 'A phone has no printer.',
    'POST /users/:p/reset-password': 'The temporary password has to be read out or written down.',
    'POST /users': 'Creating an account means conveying a temporary password — not one-handed.',
    'POST /public/signup':
      'Signing up is done by somebody who is not yet a customer and has no reason to have installed a staff app. The mobile client exists for people who already have an account at a hospital that already exists.',
    'POST /pharmacy-partners':
      'Agreeing to send prescriptions to another company is a business decision taken once, at a desk, after the two have spoken. The doctor picks from the result; the admin sets it up.',
    'DELETE /pharmacy-partners/:p': 'As above — ending a partnership is not a bedside action.',
    'PATCH /departments/:p': 'As above.',
    'DELETE /departments/:p': 'As above.',
    'GET /billing/aging': 'Reconciliation against a bank statement.',
    // `GET /billing/payments` was here and is not any more — the phone gained a
    // Payments tab, because refunding from a payment is how the reversal gets
    // recorded against the transaction it reverses.
    'POST /billing/invoices': 'Ad-hoc invoices are typed line by line; mobile raises the consultation charge.',
    'PATCH /billing/invoices/:p/void': 'Voiding needs a written reason and a moment’s thought.',
    'GET /admin/reports/activity': 'Audit-derived breakdown, read on the web dashboard.',
    'GET /admin/reports/staff': 'Headcount table, shown on the web dashboard only.',
  };

  /** Routes only mobile calls, because the web has no equivalent need. */
  const MOBILE_ONLY: Record<string, string> = {
    'POST /devices': 'Push notification registration — a browser has no device token.',
    'DELETE /devices': 'As above, on sign-out.',
    'GET /appointments/:p': 'The reschedule screen deep-links to one appointment; web opens it from the list it already has.',
    // 'PATCH /medications/doses/:p' was here, claiming "the mobile round
    // records a dose by id; the web round posts against the schedule". The web
    // round posted nothing at all — it was read-only, and the header told the
    // nurse to sign for doses on the mobile app, which is a dead end for anyone
    // at a ward terminal without a phone. A false reason in an exemption list
    // is worse than no list: it reads as a decision somebody made.
    // 'POST /vitals' was here claiming "the web vitals form posts under the
    // patient". There was no web vitals form and no such route — so the only
    // way to record an observation was from a phone that has never run on
    // hardware, and the vitals screen was empty for everybody since Phase 3.
    // Third false reason found in an exemption list; each one reads as a
    // decision somebody made rather than a gap nobody filled.
  };

  /**
   * Not decisions. Things that should exist on both and do not yet.
   *
   * Kept apart from the two lists above for the same reason `KNOWN_GAPS` is
   * kept apart from `INTENTIONALLY_UNCALLED`: one list holding both means a
   * reader skims "fine, ignore these" and the real holes vanish into it.
   */
  const PARITY_GAPS: Record<string, string> = {
    // `POST /me/password` lived here — mobile ignored `mustChangePassword`
    // entirely, so a temporary password that had been read aloud stayed live
    // indefinitely on a phone. Closed by `mobile/components/password-gate.tsx`.
    'POST /pharmacy/dispense-events/:p/reverse':
      'Reversing a dispense is reachable only from the dispensing history, which is web-only — so mobile has nowhere to put it. That is a real hole rather than a decision: "the patient cannot pay" happens at the counter, which is exactly where somebody is holding a phone. Needs a mobile entry point, most likely on the dispense confirmation itself. See PLAN.md.',
  };

  it('gives both clients the routes reception and billing need on both', () => {
    /*
     * Scoped to the roles that genuinely work across both surfaces. A doctor's
     * queue and a nurse's drug chart exist on both too, but reception and
     * billing are where the split actually bit, and widening this further
     * without a real need would turn it into a list nobody trusts.
     */
    const MUST_BE_ON_BOTH = [
      'POST /appointments/:p/invoice', // the one that was missing
      'GET /appointments',
      'POST /appointments',
      'PATCH /appointments/:p/status',
      'GET /patients',
      'POST /patients',
      'GET /billing/invoices',
      'POST /billing/invoices/:p/payments',
      'POST /billing/invoices/:p/refunds', // money must be reversible from both
      'POST /me/password', // a forced password change must work wherever you signed in
    ];

    const missing = MUST_BE_ON_BOTH.flatMap((shape) => [
      ...(webShapes.has(shape) ? [] : [`web is missing ${shape}`]),
      ...(mobileShapes.has(shape) ? [] : [`mobile is missing ${shape}`]),
    ]);

    expect(missing).toEqual([]);
  });

  it('keeps every single-client route on a list with a reason', () => {
    /*
     * The other half. A route only one client calls is usually a decision and
     * occasionally an oversight, and the two are indistinguishable until
     * someone writes down which it is.
     *
     * This fails on a NEW single-client route, so the choice gets made at the
     * moment it is introduced rather than discovered by a user months later.
     */
    const called = endpoints
      .map((e) => shapeOf(e.method, e.routePath))
      .filter((s) => calledShapes.has(s));

    /*
     * The failure names which client is missing, not just the route. "POST
     * /admissions is single-client" sends you looking in two places; "mobile
     * is missing POST /admissions" is the actual finding.
     */
    const unexplained = [...new Set(called)].flatMap((shape) => {
      const onWeb = webShapes.has(shape);
      const onMobile = mobileShapes.has(shape);
      if (onWeb && onMobile) return [];
      if ((onWeb ? WEB_ONLY : MOBILE_ONLY)[shape] || PARITY_GAPS[shape]) return [];
      return [`${onWeb ? 'mobile' : 'web'} is missing ${shape}`];
    });

    expect(unexplained).toEqual([]);
  });

  it('has no stale entry in either single-client list', () => {
    // A route that gained its second client should drop off the list, or the
    // list rots into claims nobody rechecks — the same rule the exemption
    // lists above live under.
    const stale = [
      ...Object.keys(WEB_ONLY).filter((s) => mobileShapes.has(s)),
      ...Object.keys(MOBILE_ONLY).filter((s) => webShapes.has(s)),
      ...Object.keys(PARITY_GAPS).filter((s) => webShapes.has(s) && mobileShapes.has(s)),
    ];
    expect(stale).toEqual([]);
  });

  it('writes every parity gap down in PLAN.md', () => {
    /*
     * Same rule as KNOWN_GAPS. A gap that lives only in a test file is a gap
     * nobody planning the next phase will see, and this list must not become a
     * quiet place to park things.
     */
    const plan = readFileSync(path.join(REPO_ROOT, 'PLAN.md'), 'utf8');
    const undocumented = Object.keys(PARITY_GAPS).filter(
      (shape) => !plan.includes(shape.split(' ')[1]),
    );
    expect(undocumented).toEqual([]);
  });

  it('separates parity gaps from parity decisions', () => {
    // One list holding both means a reader skims "fine, ignore these" and the
    // real holes vanish into it.
    const overlap = Object.keys(PARITY_GAPS).filter(
      (s) => WEB_ONLY[s] !== undefined || MOBILE_ONLY[s] !== undefined,
    );
    expect(overlap).toEqual([]);
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

  it('keeps the platform API out of every hospital screen', () => {
    /*
     * This used to be an outright ban: `/platform` could not appear anywhere in
     * web/ or mobile/, full stop. That was the right rule while the vendor
     * console was curl-only, and it stopped being expressible when the console
     * was built inside the web app.
     *
     * WHAT WAS GIVEN UP, STATED PLAINLY
     * ---------------------------------
     * The console shares an origin and a build with the hospital app. It does
     * not share a session — `PlatformUser` has its own login and its own token
     * audience, and `PlatformGuard` deliberately sets no `req.user`, so a
     * hospital token cannot reach a platform route however it is pointed. The
     * security boundary is unchanged and is where it always was: the server.
     *
     * What is lost is a defence-in-depth guarantee — that platform code could
     * not physically be in the bundle a receptionist loads. Next.js splits
     * route groups into their own chunks, so in practice it still isn't, but
     * "in practice" is doing work in that sentence and it is worth saying so.
     *
     * WHAT REPLACES IT
     * ----------------
     * A directory boundary, which is the strongest thing still true: only the
     * console's own files may mention the vendor API. Any other file in web/ —
     * a shared component, the hospital shell, a lib helper — fails, and mobile
     * keeps the outright ban because there is no console there at all.
     *
     * The point is unchanged. A vendor endpoint reachable from a hospital
     * screen would put break-glass and the cross-hospital tenant list on the
     * surface every receptionist loads.
     */
    const platformEndpoints = endpoints.filter((e) => e.routePath.startsWith(PLATFORM_PREFIX));
    expect(platformEndpoints.length).toBeGreaterThan(0);

    /** Only these may name the vendor API. Both are console-only. */
    const CONSOLE_ONLY = [
      path.join('web', 'app', '(platform)'),
      path.join('web', 'lib', 'platform'),
    ];

    const offenders = clientFiles.filter((file) => {
      const src = readFileSync(file, 'utf8');
      if (!src.includes('/platform') && !src.includes('break-glass')) return false;
      return !CONSOLE_ONLY.some((dir) => file.includes(dir));
    });

    expect(offenders.map((f) => path.relative(REPO_ROOT, f))).toEqual([]);

    // Mobile has no console and never will: a vendor opening break-glass from
    // a phone is not a workflow anybody asked for, and the absence is cheaper
    // to keep than to police.
    const mobileOffenders = clientFiles
      .filter((f) => f.includes(`${path.sep}mobile${path.sep}`))
      .filter((f) => {
        const src = readFileSync(f, 'utf8');
        return src.includes('/platform') || src.includes('break-glass');
      });
    expect(mobileOffenders.map((f) => path.relative(REPO_ROOT, f))).toEqual([]);
  });

  it('does not let the console call a hospital route, or the reverse', () => {
    /*
     * The boundary in the other direction, and the one a directory rule alone
     * would miss.
     *
     * A console page calling `/patients` would be a vendor screen reading
     * clinical data with a hospital's own token nowhere in sight — which is
     * exactly what `PlatformGuard` not setting `req.user` is designed to make
     * impossible on the server. Asserting it here means the mistake is caught
     * when it is written rather than when it 401s in somebody's browser.
     */
    const consoleFiles = clientFiles.filter((f) => f.includes(path.join('web', 'app', '(platform)')));

    const straying = consoleFiles.flatMap((file) =>
      clientCallsIn(readFileSync(file, 'utf8'))
        .filter((call) => !call.path.startsWith('/platform'))
        .map((call) => `${path.relative(REPO_ROOT, file)}: ${call.method} ${call.path}`),
    );

    expect(straying).toEqual([]);
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
