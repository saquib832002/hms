import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  migrationsOnDisk,
  pendingMigrations,
  pendingMigrationWarning,
} from './pending-migrations';

/**
 * The gap between `prisma generate` and `migrate deploy`.
 *
 * THE INCIDENTS THIS EXISTS FOR
 * -----------------------------
 * Three separate reports on this project, all the same cause and none of them
 * looking like it:
 *
 *   - `The column tenants.taxEnabled does not exist`
 *   - `The table public.observation_orders does not exist`
 *   - `The column prescription_items.quantityPrescribed does not exist`
 *
 * Each arrived as a 500 on whichever screen happened to touch the new column
 * first — the tax settings, the ward board, the pharmacy queue — so each was
 * reported as a bug in that feature. Every one was one command that had not
 * been run.
 *
 * An error naming a column is a consequence. The API now names the cause, at
 * boot, once.
 */

const MIGRATIONS = path.resolve(__dirname, '../../prisma/migrations');

describe('reading the migrations directory', () => {
  it('finds this project real migrations', () => {
    const found = migrationsOnDisk(MIGRATIONS);
    expect(found.length).toBeGreaterThan(5);
    // Timestamp-prefixed, so a plain sort is chronological — which is the
    // order Prisma applies them in and the order they should be listed.
    expect([...found].sort()).toEqual(found);
  });

  it('ignores the lock file and any directory without a migration.sql', () => {
    const found = migrationsOnDisk(MIGRATIONS);
    expect(found).not.toContain('migration_lock.toml');
    for (const name of found) {
      expect(() =>
        readFileSync(path.join(MIGRATIONS, name, 'migration.sql'), 'utf8'),
      ).not.toThrow();
    }
  });

  it('returns nothing rather than throwing when the directory is absent', () => {
    // A packaged build may not ship migrations. That is not an error state —
    // and this check must never be the reason an API refuses to start.
    expect(migrationsOnDisk('/no/such/place')).toEqual([]);
  });
});

describe('working out what is pending', () => {
  it('reports migrations the database has no record of', () => {
    expect(pendingMigrations(['a', 'b', 'c'], ['a'])).toEqual(['b', 'c']);
  });

  it('reports nothing when the database is up to date', () => {
    expect(pendingMigrations(['a', 'b'], ['a', 'b'])).toEqual([]);
  });

  it('ignores an applied migration that is no longer on disk', () => {
    /*
     * A branch switch or a squash. Not the failure this exists for, and
     * reporting it would train people to ignore the warning — which is how a
     * real one gets skimmed past.
     */
    expect(pendingMigrations(['b'], ['a', 'b'])).toEqual([]);
  });
});

describe('the warning', () => {
  const message = pendingMigrationWarning(['20260904200000_prescribed_quantity']);

  it('names the migration', () => {
    expect(message).toContain('20260904200000_prescribed_quantity');
  });

  it('gives the command rather than describing it', () => {
    // The whole point. Somebody reading this at 2am should be able to copy a
    // line, not work out what "apply migrations" means in this repo.
    expect(message).toContain('migrate deploy');
    expect(message).toContain('npm run db:verify');
    expect(message).toContain('npx prisma generate');
  });

  it('says when the RLS step is required and why', () => {
    /*
     * The step most easily skipped and the one with the worst consequence: a
     * table carrying tenantId with no policy reads as scoped in review and is
     * open to every hospital at runtime.
     */
    expect(message).toContain('npm run db:rls');
    expect(message).toMatch(/tenantId/);
  });
});

describe('the check itself', () => {
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const service = strip(
    readFileSync(path.resolve(__dirname, 'prisma.service.ts'), 'utf8'),
  );

  it('never stops the API from starting', () => {
    /*
     * A pending migration touching one feature must not take down the screens
     * that work without it — the same reasoning that makes a lapsed
     * subscription read-only rather than a lockout. The people harmed by a
     * refusal to boot are not the people who forgot the command.
     */
    expect(service).toMatch(/warnAboutPendingMigrations/);
    expect(service).not.toMatch(/process\.exit/);
    // Wrapped, so a database with no `_prisma_migrations` table at all — never
    // migrated, `db:setup` not yet run — cannot make this throw on boot.
    expect(service).toMatch(/catch\s*\{/);
  });
});
