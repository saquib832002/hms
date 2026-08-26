#!/usr/bin/env node
/**
 * Loads spilled audit entries back into the database.
 *
 * WHY THIS EXISTS AND IS NOT OPTIONAL
 * -----------------------------------
 * A spill file with no way back in is a write-only hole: the entries are
 * technically "not lost" and practically unreadable, which is worse than an
 * honest failure because it looks handled. `endpoint-coverage.spec.ts` exists
 * in this repo for the same reason — a feature nobody can reach is unfinished.
 *
 * Safe to run twice. Entries are matched on (requestId, action, occurredAt)
 * before insert, so a re-run after a partial success does not duplicate. The
 * audit table has no unique constraint to lean on — deliberately, since a
 * constraint that rejected a legitimate second event would lose it — so the
 * check is done here.
 *
 *   npm run audit:replay              # replay and archive the file
 *   npm run audit:replay -- --dry-run # report only, change nothing
 */

require('dotenv').config();

const { existsSync, readFileSync, renameSync, mkdirSync } = require('node:fs');
const { resolve, dirname, join } = require('node:path');

const SPILL_FILE = resolve(process.cwd(), 'var', 'audit-spill.jsonl');
const dryRun = process.argv.includes('--dry-run');

/**
 * Duplicated rather than imported from src/audit/audit-queue.ts.
 *
 * This is a plain-node script — the rest of prisma/ tooling is too — and
 * pulling in ts-node to share twenty lines would make the recovery tool depend
 * on the build being healthy. A recovery tool should have as few reasons to
 * fail as possible. `audit-queue.spec.ts` asserts the two stay in step.
 */
function parseSpill(contents) {
  const entries = [];
  let corrupt = 0;

  for (const line of contents.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed?.action === 'string' && typeof parsed?.outcome === 'string') {
        entries.push(parsed);
      } else {
        corrupt += 1;
      }
    } catch {
      corrupt += 1;
    }
  }

  return { entries, corrupt };
}

async function main() {
  if (!existsSync(SPILL_FILE)) {
    console.log(`No spill file at ${SPILL_FILE} — nothing to replay.`);
    return;
  }

  const { entries, corrupt } = parseSpill(readFileSync(SPILL_FILE, 'utf8'));

  console.log(`Spill file: ${SPILL_FILE}`);
  console.log(`  ${entries.length} entries readable`);
  if (corrupt > 0) {
    // Reported, never silently skipped. A truncated last line is the expected
    // case after a hard kill; anything more is worth looking at.
    console.log(`  ${corrupt} line(s) unreadable — left in place, not replayed`);
  }
  if (entries.length === 0) return;

  /*
   * Connects as the ADMIN url, not the app role.
   *
   * hms_app is subject to RLS, and these rows span hospitals — including
   * unattributed ones with a NULL tenantId, which no tenant-scoped connection
   * can insert or see. Recovery is exactly the case the owner connection is
   * for.
   */
  const url = process.env.DATABASE_URL_ADMIN || process.env.DATABASE_URL;
  if (!url) {
    console.error('Neither DATABASE_URL_ADMIN nor DATABASE_URL is set.');
    process.exitCode = 1;
    return;
  }

  const { Client } = require('pg');
  const client = new Client({ connectionString: url });
  await client.connect();

  let inserted = 0;
  let skipped = 0;

  try {
    for (const e of entries) {
      const dup = await client.query(
        `SELECT 1 FROM audit_logs
          WHERE action = $1
            AND "createdAt" = $2
            AND ($3::text IS NULL OR "requestId" = $3)
          LIMIT 1`,
        [e.action, e.occurredAt, e.requestId ?? null],
      );

      if (dup.rowCount > 0) {
        skipped += 1;
        continue;
      }

      if (dryRun) {
        inserted += 1;
        continue;
      }

      await client.query(
        `INSERT INTO audit_logs
           ("tenantId","userId","actorEmail","actorRole",action,method,path,
            "targetType","targetId",outcome,"statusCode","ipAddress","userAgent",
            "requestId","createdAt")
         VALUES ($1,$2,$3,$4::"UserRole",$5,$6,$7,$8,$9,$10::"AuditOutcome",$11,$12,$13,$14,$15)`,
        [
          e.tenantId ?? null,
          e.userId ?? null,
          e.actorEmail ?? null,
          e.actorRole ?? null,
          e.action,
          e.method ?? null,
          e.path ?? null,
          e.targetType ?? null,
          e.targetId ?? null,
          e.outcome,
          e.statusCode ?? null,
          e.ipAddress ?? null,
          e.userAgent ?? null,
          e.requestId ?? null,
          e.occurredAt,
        ],
      );
      inserted += 1;
    }
  } finally {
    await client.end();
  }

  if (dryRun) {
    console.log(`\nDry run: ${inserted} would be inserted, ${skipped} already present.`);
    console.log('Re-run without --dry-run to apply.');
    return;
  }

  console.log(`\n${inserted} inserted, ${skipped} already present.`);

  /*
   * Archived rather than deleted, and only when every entry is accounted for.
   *
   * Deleting the evidence at the end of a recovery is the wrong instinct for
   * this file in particular. If some lines were unreadable the file stays put,
   * because moving it would bury them.
   */
  if (corrupt === 0) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const archive = join(dirname(SPILL_FILE), `audit-spill.${stamp}.replayed.jsonl`);
    mkdirSync(dirname(archive), { recursive: true });
    renameSync(SPILL_FILE, archive);
    console.log(`Spill file archived to ${archive}`);
  } else {
    console.log('Spill file left in place because it contains unreadable lines.');
  }
}

main().catch((err) => {
  console.error('Replay failed:', err.message);
  process.exitCode = 1;
});
