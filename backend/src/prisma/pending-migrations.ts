import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

/**
 * Migrations on disk that the database has not applied.
 *
 * WHY THIS RUNS AT BOOT
 * ---------------------
 * The Prisma *client* is generated from `schema.prisma`, and the *database* is
 * changed by a migration. Those are two separate steps, and between them the
 * running API queries columns that do not exist yet.
 *
 * That gap has now produced three separate incident reports on this project,
 * each arriving as an unrelated-looking 500 on whichever screen happened to
 * touch the new column first:
 *
 *   - `The column tenants.taxEnabled does not exist`      → the tax work
 *   - `The table public.observation_orders does not exist` → the ward board
 *   - `The column prescription_items.quantityPrescribed does not exist`
 *                                                          → the pharmacy queue
 *
 * Every one of them was the same thing: `prisma generate` had run and
 * `migrate deploy` had not. The error names a column, which sends whoever is
 * reading it looking at the feature that column belongs to, and the actual
 * cause is one command that was never run.
 *
 * So the API says so on startup instead, once, naming the migrations and the
 * command. A boot-time warning somebody reads beats a runtime error somebody
 * has to decode.
 *
 * DELIBERATELY A WARNING, NOT A REFUSAL
 * -------------------------------------
 * Refusing to start would be tidier and is the wrong trade for a hospital: a
 * pending migration that touches one feature would take the whole system down,
 * including the screens that work perfectly well without it. The same reasoning
 * as `SubscriptionGuard` — a lapsed subscription blocks writes and never blocks
 * a read, because the people harmed by a lockout are not the people who caused
 * it. Say it loudly and keep serving.
 */

/** A migration directory Prisma would apply, newest last. */
export function migrationsOnDisk(migrationsDir: string): string[] {
  if (!existsSync(migrationsDir)) return [];
  return readdirSync(migrationsDir)
    .filter((entry) => {
      if (entry === 'migration_lock.toml') return false;
      return existsSync(path.join(migrationsDir, entry, 'migration.sql'));
    })
    .sort();
}

/**
 * Which of those the database has no record of.
 *
 * `applied` comes from `_prisma_migrations`, which is Prisma's own table. A
 * migration recorded there but missing from disk is not reported: that is a
 * branch switch or a squash, and it is not the failure this exists for.
 */
export function pendingMigrations(onDisk: string[], applied: string[]): string[] {
  const done = new Set(applied);
  return onDisk.filter((name) => !done.has(name));
}

/** The message, kept here so a test can assert it names the command. */
export function pendingMigrationWarning(pending: string[]): string {
  return [
    '',
    '  ┌─────────────────────────────────────────────────────────────────────┐',
    `  │  ${pending.length} MIGRATION${pending.length === 1 ? '' : 'S'} NOT APPLIED TO THIS DATABASE`.padEnd(71) + '│',
    '  └─────────────────────────────────────────────────────────────────────┘',
    '',
    ...pending.map((m) => `    · ${m}`),
    '',
    '  The Prisma client expects columns and tables the database does not have,',
    '  so requests touching them will fail with an error naming the column —',
    '  which reads as a bug in that feature and is not one.',
    '',
    '  From backend/:',
    '',
    '    npm run db:verify                          # see the diff first',
    '    node prisma/admin-cli.js migrate deploy    # apply them',
    '    npx prisma generate',
    '    npm run db:rls                             # if any migration adds a table',
    '',
    '  `npm run db:rls` is required whenever a migration creates a table that',
    '  carries tenantId: a table with that column and no policy reads as scoped',
    '  in review and is open to every hospital at runtime.',
    '',
  ].join('\n');
}
