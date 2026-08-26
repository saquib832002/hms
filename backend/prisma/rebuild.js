#!/usr/bin/env node
/**
 * Rebuilds the database from nothing, in the right order, stopping at the
 * first real failure.
 *
 *   npm run db:rebuild
 *
 * WHY THIS EXISTS
 * ---------------
 * The setup is five steps across three tools (Prisma CLI, a SQL file, a seed
 * script), and running them by hand made it very easy to lose which one failed
 * — a step would error, the next would be run anyway, and the eventual symptom
 * would point somewhere else entirely. Every failure in this project's setup so
 * far has been of that shape.
 *
 * This runs them in order, refuses to continue past a failure, and labels each
 * one, so a single output says where the problem actually is.
 */
const { spawnSync } = require('node:child_process');
const { resolve } = require('node:path');

const cwd = resolve(__dirname, '..');
const node = process.execPath;

const STEPS = [
  {
    name: 'Clear the database',
    why: 'drops every table so the rebuild starts from nothing',
    cmd: [node, ['prisma/admin-cli.js', 'migrate', 'reset', '--force', '--skip-seed']],
  },
  {
    name: 'Create and apply the migration',
    why: 'writes prisma/migrations/<stamp>_init from schema.prisma — this is what creates the tenants table and every tenantId column',
    cmd: [node, ['prisma/admin-cli.js', 'migrate', 'dev', '--name', 'init', '--skip-seed']],
  },
  {
    name: 'Seed two hospitals',
    why: 'dummy data only',
    cmd: [node, ['-r', 'ts-node/register', 'prisma/seed.ts']],
  },
  {
    name: 'Apply Row-Level Security',
    why: 'creates the hms_app role and the tenant isolation policies',
    cmd: [node, ['prisma/apply-rls.js']],
  },
  {
    name: 'Check the result',
    why: '',
    cmd: [node, ['prisma/doctor.js']],
  },
];

for (const [i, step] of STEPS.entries()) {
  console.log(`\n${'═'.repeat(64)}`);
  console.log(` STEP ${i + 1} of ${STEPS.length} — ${step.name}`);
  if (step.why) console.log(` ${step.why}`);
  console.log('═'.repeat(64));

  const [bin, args] = step.cmd;

  // Captured rather than inherited, so the failure can be repeated *below* the
  // banner. Inherited output scrolls above it, and the error — the only part
  // that identifies the problem — is exactly what gets lost when the result is
  // copied out of a terminal.
  const r = spawnSync(bin, args, { cwd, encoding: 'utf8', env: process.env });
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  process.stdout.write(output);

  if (r.status !== 0) {
    const tail = output.trimEnd().split('\n').slice(-30).join('\n');
    console.error(`\n${'─'.repeat(64)}`);
    console.error(` STEP ${i + 1} FAILED — "${step.name}" exited with ${r.status}`);
    console.error(' Nothing after this ran. It is safe to re-run db:rebuild.');
    console.error('─'.repeat(64));
    console.error('\n>>>>> COPY FROM HERE >>>>>');
    console.error(tail || '(the command produced no output at all)');
    console.error('<<<<< COPY TO HERE <<<<<\n');
    process.exit(r.status ?? 1);
  }
}

console.log('\nDatabase rebuilt. Start the API with:  npm run dev\n');
