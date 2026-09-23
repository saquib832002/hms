import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * A hospital must be able to set itself up through the API alone.
 *
 * THE BUG THIS EXISTS FOR
 * -----------------------
 * `Ward` and `Bed` rows were created by `prisma/seed.ts` and by nothing else.
 * There was no `POST /wards`, no `POST /wards/:id/beds`, and provisioning
 * created neither — so every hospital that arrived through the platform, which
 * is every real one, had zero wards and no way to make one short of a database
 * console.
 *
 * The cost landed two roles away from the omission. A nurse's landing screen is
 * the ward board; it asked `GET /wards`, got `[]`, selected no ward, therefore
 * never requested a board, and sat on its loading skeleton indefinitely.
 * Reported as "the ward board never loads — is the backend slow?". Nothing was
 * slow. There was nothing to load, and no screen said so.
 *
 * This is the third time the same shape has appeared:
 *
 *   - the medicine catalogue was seed-only for six phases, so a hospital that
 *     skipped the demo seed had nothing to receive stock against and the
 *     pharmacy did not work at all;
 *   - a doctor profile could only be made as a side effect of creating a new
 *     user, so an owner-doctor needed a second account;
 *   - wards and beds, here.
 *
 * Every one was found on a real deployment, by a user, never by a test —
 * because an empty table and an unbuilt feature render identically.
 *
 * WHY THIS IS NOT `endpoint-coverage`
 * -----------------------------------
 * That test asks whether every endpoint has a caller. It structurally cannot
 * see a resource with *no endpoint at all* — there is nothing for it to find
 * missing. This asks the opposite question: for each thing a hospital must
 * create before the system works, does a way to create it exist?
 *
 * Read from source rather than by importing the controllers, for the same
 * reason `endpoint-coverage` is: importing `UsersController` drags in
 * `@node-rs/argon2` and its native binding, and a test that needs a toolchain
 * is a test that gets skipped on the machine where it would have mattered.
 */

const SRC = path.resolve(__dirname, '..', '..');
const SEED = path.resolve(SRC, '..', 'prisma', 'seed.ts');

function walk(dir: string, match: RegExp): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, match));
    else if (match.test(entry)) out.push(full);
  }
  return out;
}

/** `@Controller('x')` and the `@Get`/`@Post`/… decorators beneath it. */
function endpointsIn(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  const found: string[] = [];

  // A file may hold more than one controller (vitals, medications).
  const blocks = [...src.matchAll(/@Controller\((?:'([^']*)')?\)/g)];

  for (const [i, block] of blocks.entries()) {
    const body = src.slice(block.index ?? 0, blocks[i + 1]?.index ?? src.length);
    const base = block[1] ?? '';

    for (const m of body.matchAll(/@(Get|Post|Patch|Put|Delete)\((?:'([^']*)')?\)/g)) {
      const segments = [base, m[2] ?? ''].filter(Boolean).join('/').split('/').filter(Boolean);
      found.push(`${m[1].toUpperCase()} /${segments.join('/')}`);
    }
  }
  return found;
}

/** `/wards/:id/beds` and `/wards/:wardId/beds` are the same route to this test. */
const normalise = (shape: string) => shape.replace(/:[A-Za-z0-9_]+/g, ':p');

/**
 * Everything a hospital has to create before somebody can do their job, the
 * route that creates it, and the role blocked when it cannot.
 *
 * `blocks` is prose rather than a code reference on purpose. The whole point of
 * the column is that the failure surfaces somewhere other than the missing
 * endpoint — two roles away, in the ward board's case — and naming where is
 * what makes an entry worth reading rather than a name to tick off.
 */
const MUST_BE_CREATABLE: { model: string; route: string; blocks: string }[] = [
  {
    model: 'ward',
    route: 'POST /wards',
    blocks: "the nurse's ward board and drug round are both empty, and nobody can be admitted",
  },
  {
    model: 'bed',
    route: 'POST /wards/:p/beds',
    blocks: 'a ward with no beds accepts no admissions and draws an empty board',
  },
  {
    model: 'department',
    route: 'POST /departments',
    blocks: 'doctors cannot be filed against one',
  },
  {
    model: 'doctor',
    route: 'POST /users/:p/doctor-profile',
    blocks: 'an owner-doctor cannot prescribe without keeping a second account',
  },
  {
    model: 'medicine',
    route: 'POST /medicines',
    blocks: 'stock cannot be received and the pharmacy does not work at all',
  },
  {
    model: 'taxRate',
    route: 'POST /tax-rates',
    blocks: 'a hospital that charges tax cannot invoice correctly',
  },
  {
    /*
     * The fourth time this shape would have appeared.
     *
     * The medicine catalogue, doctor profiles and wards were each seed-only for
     * six phases, and each was found on a real deployment by a user rather than
     * by a test — because an empty table and an unbuilt feature render
     * identically, and the symptom surfaces two roles away from the gap.
     *
     * With no test catalogue a doctor's ordering sheet is empty, the lab's
     * worklist never fills, and nothing on either screen says why.
     */
    model: 'labTest',
    route: 'POST /lab-tests',
    blocks:
      "a doctor cannot request a single investigation and the laboratory's worklist never fills",
  },
];

describe('a hospital can set itself up through the API', () => {
  const controllers = walk(SRC, /\.controller\.ts$/);
  const shapes = new Set(controllers.flatMap(endpointsIn).map(normalise));

  it('finds the controllers', () => {
    expect(controllers.length).toBeGreaterThan(5);
    expect(shapes.size).toBeGreaterThan(20);
  });

  it('has a create route for everything a hospital needs before it can work', () => {
    const missing = MUST_BE_CREATABLE.filter((e) => !shapes.has(normalise(e.route))).map(
      (e) => `${e.route} does not exist — without it, ${e.blocks}`,
    );

    expect(missing).toEqual([]);
  });

  it('leaves no setup resource that only the demo seed can create', () => {
    /*
     * The seed is a demo fixture, not a setup path. Any model it is the only
     * writer of is one a real hospital cannot create — which is exactly the
     * state wards were in, and the catalogue before them.
     *
     * The seed is read as text rather than run: executing it needs a database,
     * and this suite deliberately needs none.
     */
    const seed = readFileSync(SEED, 'utf8');

    const seedOnly = MUST_BE_CREATABLE.filter(
      (e) =>
        new RegExp(`\\b${e.model}\\.create`).test(seed) && !shapes.has(normalise(e.route)),
    ).map((e) => `${e.model} exists only in seed.ts — without an API route, ${e.blocks}`);

    expect(seedOnly).toEqual([]);
  });

  it('still names a role that is blocked, for every entry', () => {
    // A row with no consequence written down decays into a list of names, and
    // then into a list nobody rechecks. Same rule as the exemption lists in
    // `endpoint-coverage`.
    const unexplained = MUST_BE_CREATABLE.filter((e) => e.blocks.trim().length < 20).map(
      (e) => `${e.route} has no stated consequence`,
    );
    expect(unexplained).toEqual([]);
  });
});
