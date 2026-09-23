import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { SESSION_USER_INCLUDE } from '../auth/session-user';

/**
 * The migrations and the model must agree, and for eleven migrations nothing
 * checked that they did.
 *
 * THE BUG THIS EXISTS FOR
 * -----------------------
 * `Tenant.modules` shipped as a hand-written migration that added the column, a
 * `TenantModule` enum in the schema, a guard that read it, a vendor console
 * that set it, and three clients that narrowed their menus by it — and **no
 * field on `model Tenant`**. Every piece of the feature was present except the
 * one line joining the database to the code.
 *
 * The failure that produced is worth spelling out, because it looks nothing
 * like its cause. `prisma generate` builds the client from the *model*, so the
 * generated client had no `modules`; `SESSION_USER_INCLUDE` selects it, so
 * every login would have thrown `Unknown field 'modules'`; and the one file
 * that would not compile was `platform.service.ts`, four files away. A watching
 * dev server holds the last good build when compilation fails, so the running
 * API was simply the one from before modules existed — enforcing nothing,
 * looking healthy, and reported as "I set a tenant to pharmacy-only and they
 * can still do everything".
 *
 * WHY A TEST AND NOT `prisma migrate diff`
 * ----------------------------------------
 * `migrate diff` is the right tool and needs the schema engine binary, whose
 * download is blocked on the machine this is authored on — which is why all
 * twelve migrations here are hand-written in the first place. This is the
 * check that survives that constraint: text against text, no engine, no
 * database, running in the same suite as everything else.
 *
 * It is deliberately not a general schema comparison. It answers one question —
 * *does every column a migration adds exist on the model that owns the table* —
 * which is the direction that fails silently. The reverse (a model field with
 * no column) fails loudly on the first query and needs no test.
 */

const PRISMA = path.resolve(__dirname, '../../prisma');
const SCHEMA = readFileSync(path.join(PRISMA, 'schema.prisma'), 'utf8');

interface Model {
  name: string;
  /** The SQL table, from `@@map` or the model name. */
  table: string;
  /** Column names: a field's `@map`, else the field name. */
  columns: Set<string>;
}

/**
 * Parse the models out of `schema.prisma`.
 *
 * Enough of a parser for the question being asked and no more. Relations,
 * attributes and block comments are all just text to skip — what matters is the
 * set of column names a model claims.
 */
function parseModels(schema: string): Model[] {
  const models: Model[] = [];

  for (const block of schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    const [, name, body] = block;
    const table = /@@map\("([^"]+)"\)/.exec(body)?.[1] ?? name;
    const columns = new Set<string>();

    for (const raw of body.split('\n')) {
      const line = raw.trim();
      // Comments, block attributes and blank lines carry no field.
      if (!line || line.startsWith('//') || line.startsWith('///') || line.startsWith('@@')) {
        continue;
      }
      const field = /^(\w+)\s+\S/.exec(line);
      if (!field) continue;
      columns.add(/@map\("([^"]+)"\)/.exec(line)?.[1] ?? field[1]);
    }

    models.push({ name, table, columns });
  }

  return models;
}

const MODELS = parseModels(SCHEMA);
const BY_TABLE = new Map(MODELS.map((m) => [m.table, m]));

/** Every `ADD COLUMN`, minus anything a later migration dropped. */
function columnsAddedByMigrations() {
  const added: { table: string; column: string; migration: string }[] = [];
  const dropped = new Set<string>();

  const migrations = readdirSync(path.join(PRISMA, 'migrations'))
    .filter((d) => !d.endsWith('.toml'))
    .sort();

  for (const migration of migrations) {
    let sql: string;
    try {
      sql = readFileSync(path.join(PRISMA, 'migrations', migration, 'migration.sql'), 'utf8');
    } catch {
      continue;
    }

    /*
     * Statements can wrap across lines and carry several clauses, so the table
     * is captured once and the columns swept out of the statement body. Prisma
     * writes `ALTER TABLE "x" ADD COLUMN "y" TYPE,` with a run of spaces; a
     * hand-written one usually writes a single space. Both are matched.
     */
    for (const statement of sql.matchAll(/ALTER TABLE\s+"(\w+)"([\s\S]*?);/g)) {
      const [, table, body] = statement;
      for (const add of body.matchAll(/ADD COLUMN\s+(?:IF NOT EXISTS\s+)?"(\w+)"/g)) {
        added.push({ table, column: add[1], migration });
      }
      for (const drop of body.matchAll(/DROP COLUMN\s+(?:IF EXISTS\s+)?"(\w+)"/g)) {
        dropped.add(`${table}.${drop[1]}`);
      }
    }
  }

  return added.filter((a) => !dropped.has(`${a.table}.${a.column}`));
}

const ADDED = columnsAddedByMigrations();

describe('the migrations and the model agree', () => {
  it('finds the schema and the migrations', () => {
    // Vacuous-pass guard. A moved directory or a parser that matched nothing
    // would make every assertion below true while checking nothing at all —
    // which is the failure mode this whole file is about.
    expect(MODELS.length).toBeGreaterThan(30);
    expect(ADDED.length).toBeGreaterThan(20);
    expect(BY_TABLE.get('tenants')?.columns.size).toBeGreaterThan(15);
  });

  it('declares a field for every column a migration adds', () => {
    /*
     * THE ASSERTION THIS FILE EXISTS FOR.
     *
     * A column in the database that no model mentions is invisible to Prisma,
     * so the feature reading it is dead — and dead in the quietest possible
     * way, because the SQL is right there in the migration and looks done.
     */
    const missing = ADDED.filter(({ table, column }) => {
      const model = BY_TABLE.get(table);
      // A table with no model at all is a different fault, asserted below.
      return model !== undefined && !model.columns.has(column);
    }).map(({ table, column, migration }) => `${table}.${column} (${migration})`);

    expect(missing).toEqual([]);
  });

  it('has a model for every table a migration alters', () => {
    const orphans = [...new Set(ADDED.map((a) => a.table))].filter((t) => !BY_TABLE.has(t));
    expect(orphans).toEqual([]);
  });

  it('knows that tenants.modules is one of them', () => {
    /*
     * Pinned by name rather than left to the sweep above.
     *
     * This is the column the general check was written after, and a regression
     * here is not a tidy-up — it is the entitlement system silently enforcing
     * nothing while every test around it stays green.
     */
    expect(ADDED).toContainEqual(
      expect.objectContaining({ table: 'tenants', column: 'modules' }),
    );
    expect(BY_TABLE.get('tenants')?.columns.has('modules')).toBe(true);
  });
});

describe('a relaxed column is optional on the model', () => {
  /*
   * `ALTER COLUMN ... DROP NOT NULL` is invisible to the sweep above, which
   * only reads `ADD COLUMN` — and it produced a live 500.
   *
   * `lab_orders.doctorId` was made optional on the model and the SQL for it was
   * *appended to a migration that had already been applied*. Prisma checksums
   * each migration, so an edited one is never re-run by `migrate deploy` and
   * can fail it outright. The client then believed the column was nullable
   * while the database still refused a null, and accepting a referral died on
   * a null-constraint violation.
   *
   * The rule that failure teaches — never edit an applied migration, add
   * another — cannot be checked without the database. What can be checked is
   * the pairing: if some migration relaxes a column, the model must agree that
   * it is optional. That is the half that catches the mistake in review.
   */
  const relaxed = (() => {
    const out: { table: string; column: string }[] = [];
    const dir = path.join(PRISMA, 'migrations');
    for (const migration of readdirSync(dir).filter((d) => !d.endsWith('.toml')).sort()) {
      let sql: string;
      try {
        sql = readFileSync(path.join(dir, migration, 'migration.sql'), 'utf8');
      } catch {
        continue;
      }
      for (const m of sql.matchAll(
        /ALTER TABLE\s+"(\w+)"\s+ALTER COLUMN\s+"(\w+)"\s+DROP NOT NULL/g,
      )) {
        out.push({ table: m[1], column: m[2] });
      }
    }
    return out;
  })();

  it('finds the relaxations it is checking', () => {
    // Vacuous-pass guard, and it names the one that caused the outage.
    expect(relaxed).toContainEqual({ table: 'lab_orders', column: 'doctorId' });
  });

  it.each(relaxed)('$table.$column is optional on the model', ({ table, column }) => {
    const model = MODELS.find((m) => m.table === table);
    expect(model).toBeDefined();

    /*
     * Read from the schema text rather than the parsed column set, because the
     * question here is about the `?`, which the parser deliberately discards.
     */
    const block = new RegExp(`^model ${model!.name} \\{([\\s\\S]*?)^\\}`, 'm').exec(SCHEMA);
    expect(block).not.toBeNull();

    const field = new RegExp(`^\\s*${column}\\s+(\\S+)`, 'm').exec(block![1]);
    expect(field).not.toBeNull();
    expect(field![1]).toMatch(/\?$/);
  });
});

describe('the session user selects only fields that exist', () => {
  /*
   * The narrower half of the same bug, and the one that actually broke login.
   *
   * `SESSION_USER_INCLUDE` is read on every authenticated request, so a field
   * named here that the model does not have is not a degraded feature — it is
   * a 500 on the first request of every session. Worth its own assertion
   * because the blast radius is the whole application rather than one screen.
   */
  it('selects a real column for every field it names on the tenant', () => {
    const selected = Object.keys(SESSION_USER_INCLUDE.tenant.select);
    const tenant = BY_TABLE.get('tenants');

    expect(tenant).toBeDefined();
    expect(selected.length).toBeGreaterThan(4);
    expect(selected.filter((f) => !tenant!.columns.has(f))).toEqual([]);
  });

  it('carries the modules, because everything downstream fails open without them', () => {
    /*
     * `navFor`, `canReach` and `assignableRoles` all treat an absent module
     * list as "do not narrow" — deliberately, because a blank menu for every
     * member of staff is worse than a wide one when a build is stale.
     *
     * The cost of that choice is that a missing field disables the restriction
     * rather than the feature, silently and completely. So the field being
     * carried is asserted here rather than trusted.
     */
    expect(Object.keys(SESSION_USER_INCLUDE.tenant.select)).toContain('modules');
  });
});
