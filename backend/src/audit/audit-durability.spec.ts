import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AuditOutcome } from '@prisma/client';
import { parseSpill } from './audit-queue';

/**
 * The behaviour of the queue, not the shape of its rules.
 *
 * `audit-queue.spec.ts` covers the policy. This covers what the service
 * actually does with a database that misbehaves — which is the part the old
 * fire-and-forget path got wrong, and the part no static test can see.
 *
 * The last live run found three bugs that 513 unit tests missed, all of them
 * wrong assumptions about how parts fit together at runtime. So these drive the
 * real service with a fake Prisma rather than asserting on its source.
 */

// The service resolves its spill path from cwd at import time, so cwd has to be
// set before the module is loaded.
const workdir = mkdtempSync(join(tmpdir(), 'audit-spill-'));
const originalCwd = process.cwd();
process.chdir(workdir);

/* eslint-disable @typescript-eslint/no-var-requires */
const { AuditService, SPILL_FILE } = require('./audit.service') as typeof import('./audit.service');

afterAll(() => {
  process.chdir(originalCwd);
  rmSync(workdir, { recursive: true, force: true });
});

/**
 * Services created by a test keep retrying after it finishes, which leaves Jest
 * with open timers and — worse — lets one test's spill land in the next test's
 * assertions. Each one is shut down before the next runs.
 */
const live: Array<{ onApplicationShutdown(signal?: string): Promise<void> }> = [];

const track = <T extends { onApplicationShutdown(signal?: string): Promise<void> }>(s: T): T => {
  live.push(s);
  return s;
};

afterEach(async () => {
  while (live.length) await live.pop()!.onApplicationShutdown('test');
});

const readSpill = () =>
  existsSync(SPILL_FILE) ? parseSpill(readFileSync(SPILL_FILE, 'utf8')).entries : [];

const clearSpill = () => rmSync(SPILL_FILE, { force: true });

/** A Prisma stand-in whose failure behaviour each test controls. */
function fakePrisma(behaviour: { failTimes: number }) {
  let calls = 0;

  const insert = () => {
    calls += 1;
    if (calls <= behaviour.failTimes) {
      return Promise.reject(new Error('connection terminated unexpectedly'));
    }
    return Promise.resolve({});
  };

  return {
    calls: () => calls,
    client: {
      unscoped: { auditLog: { createMany: insert } },
      auditLog: { create: insert },
      forTenant: (_id: number, fn: () => Promise<unknown>) => fn(),
    },
  };
}

const entry = (over: Record<string, unknown> = {}) =>
  ({
    tenantId: 1,
    action: 'READ_PATIENT',
    outcome: AuditOutcome.SUCCESS,
    requestId: 'req-1',
    ...over,
  }) as Parameters<InstanceType<typeof AuditService>['record']>[0];

/** The queue drains asynchronously; give it room without racing the clock. */
const settle = () => new Promise((r) => setTimeout(r, 3_000));

describe('a database that fails once', () => {
  beforeEach(clearSpill);

  it('retries and keeps the row out of the spill file', async () => {
    const prisma = fakePrisma({ failTimes: 1 });
    const service = track(new AuditService(prisma.client as never));

    service.record(entry());
    await settle();

    expect(prisma.calls()).toBe(2);
    expect(readSpill()).toHaveLength(0);
    expect(service.stats().retried).toBe(1);
  });
});

describe('a database that will not accept writes at all', () => {
  beforeEach(clearSpill);

  it('spills the entry rather than losing it', async () => {
    /*
     * The whole point of the change. Previously this logged an error and the
     * row was gone — and since denials started flowing through here, "gone"
     * means a security event nobody can reconstruct.
     */
    const prisma = fakePrisma({ failTimes: Infinity });
    const service = track(new AuditService(prisma.client as never));

    service.record(entry({ action: 'DENIED_PATIENT_READ', outcome: AuditOutcome.FAILURE }));
    await settle();

    const spilled = readSpill();
    expect(spilled).toHaveLength(1);
    expect(spilled[0]).toMatchObject({
      action: 'DENIED_PATIENT_READ',
      outcome: AuditOutcome.FAILURE,
      requestId: 'req-1',
    });
    // Whoever opens this file at 3am should not have to guess why.
    expect(spilled[0].spillReason).toContain('connection terminated');
  });

  it('never rejects, so a failing audit cannot fail the request it describes', async () => {
    const prisma = fakePrisma({ failTimes: Infinity });
    const service = track(new AuditService(prisma.client as never));

    // record() is called from AllExceptionsFilter while a request is already
    // failing. Throwing here would replace a useful error with a confusing one.
    expect(() => service.record(entry())).not.toThrow();
    await settle();
  });
});

describe('shutdown', () => {
  beforeEach(clearSpill);

  it('drains queued entries before the process exits', async () => {
    const prisma = fakePrisma({ failTimes: 0 });
    const service = track(new AuditService(prisma.client as never));

    for (let i = 0; i < 5; i++) service.record(entry({ requestId: `req-${i}` }));
    await service.onApplicationShutdown('SIGTERM');

    expect(prisma.calls()).toBe(5);
    expect(readSpill()).toHaveLength(0);
    expect(service.stats().queued).toBe(0);
  });

  it('spills whatever it could not write instead of exiting with it in memory', async () => {
    const prisma = fakePrisma({ failTimes: Infinity });
    const service = track(new AuditService(prisma.client as never));

    for (let i = 0; i < 3; i++) service.record(entry({ requestId: `req-${i}` }));
    await service.onApplicationShutdown('SIGTERM');

    // A deploy against an unhealthy database must not silently discard the
    // trail — nor hang waiting for it.
    expect(readSpill()).toHaveLength(3);
    expect(service.stats().queued).toBe(0);
  }, 30_000);
});

describe('the spill path', () => {
  it('is inside the backend working directory, not a temp dir', () => {
    // A spill file in /tmp is one reboot away from being the loss it exists to
    // prevent, and on some hosts it is world-readable.
    expect(SPILL_FILE).toBe(resolve(process.cwd(), 'var', 'audit-spill.jsonl'));
  });
});
