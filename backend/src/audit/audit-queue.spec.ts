import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AuditOutcome } from '@prisma/client';
import {
  MAX_ATTEMPTS,
  MAX_QUEUE,
  SpilledEntry,
  backoffMs,
  overflowAction,
  parseSpill,
  shouldRetry,
  toSpillLine,
} from './audit-queue';

const entry = (over: Partial<SpilledEntry> = {}): SpilledEntry => ({
  tenantId: 1,
  userId: 7,
  actorEmail: 'nurse@example.test',
  actorRole: null,
  action: 'READ_PATIENT',
  method: 'GET',
  path: '/api/v1/patients/12',
  targetType: 'Patient',
  targetId: 12,
  outcome: AuditOutcome.SUCCESS,
  statusCode: 200,
  ipAddress: '10.0.0.4',
  userAgent: 'jest',
  requestId: 'req-1',
  occurredAt: '2026-08-24T09:00:00.000Z',
  spillReason: 'test',
  ...over,
});

describe('overflow', () => {
  it('spills instead of dropping once the queue is full', () => {
    /*
     * The rule that matters most here. A denied request is a security event,
     * so an attacker who can make audit writes fail must not thereby be able to
     * make them disappear. There is no 'drop' branch to test because the type
     * has no such value.
     */
    expect(overflowAction(0)).toBe('enqueue');
    expect(overflowAction(MAX_QUEUE - 1)).toBe('enqueue');
    expect(overflowAction(MAX_QUEUE)).toBe('spill');
    expect(overflowAction(MAX_QUEUE + 500)).toBe('spill');
  });

  it('bounds the queue at all', () => {
    // An unbounded queue turns a database outage into a memory leak, and the
    // process dies holding the rows it was trying to protect.
    expect(Number.isFinite(MAX_QUEUE)).toBe(true);
    expect(MAX_QUEUE).toBeGreaterThan(0);
  });
});

describe('retry', () => {
  it('gives up after a bounded number of attempts', () => {
    for (let i = 1; i < MAX_ATTEMPTS; i++) expect(shouldRetry(i)).toBe(true);
    expect(shouldRetry(MAX_ATTEMPTS)).toBe(false);
    expect(shouldRetry(MAX_ATTEMPTS + 10)).toBe(false);
  });

  it('backs off, and caps', () => {
    expect(backoffMs(1)).toBe(50);
    expect(backoffMs(2)).toBe(100);
    expect(backoffMs(3)).toBe(200);
    // Capped: the point is to ride out a blip, not to wait out an outage. An
    // outage should reach the spill file quickly, where the rows are visible.
    expect(backoffMs(20)).toBe(800);
    expect(backoffMs(0)).toBe(0);
  });

  it('spends under a second in total', () => {
    // A retry budget long enough to matter would queue writes behind a broken
    // database and turn a slow insert into a memory problem.
    let total = 0;
    for (let i = 1; i < MAX_ATTEMPTS; i++) total += backoffMs(i);
    expect(total).toBeLessThan(1_000);
  });
});

describe('the spill file', () => {
  it('is one JSON object per line', () => {
    const line = toSpillLine(entry());
    expect(line.endsWith('\n')).toBe(true);
    expect(line.trimEnd()).not.toContain('\n');
    expect(JSON.parse(line)).toMatchObject({ action: 'READ_PATIENT', targetId: 12 });
  });

  it('survives a truncated final line', () => {
    /*
     * The case this format exists for. A single JSON array would be corrupt the
     * moment the process died mid-append — which is precisely when this file
     * matters. JSONL loses only the partial line.
     */
    const good = toSpillLine(entry({ requestId: 'a' })) + toSpillLine(entry({ requestId: 'b' }));
    const truncated = good + '{"action":"READ_PAT';

    const { entries, corrupt } = parseSpill(truncated);
    expect(entries.map((e) => e.requestId)).toEqual(['a', 'b']);
    expect(corrupt).toBe(1);
  });

  it('reports unreadable lines rather than skipping them silently', () => {
    const { entries, corrupt } = parseSpill('not json\n' + toSpillLine(entry()) + '\n\n');
    expect(entries).toHaveLength(1);
    expect(corrupt).toBe(1);
  });

  it('rejects JSON that is not an audit entry', () => {
    // A bare `{}` parses fine and would insert a row with a null action,
    // corrupting the trail with something that looks like a real event.
    const { entries, corrupt } = parseSpill('{}\n[]\n"hello"\n');
    expect(entries).toHaveLength(0);
    expect(corrupt).toBe(3);
  });

  it('round-trips every field, including the null ones', () => {
    // A dropped null would turn "no tenant" (an anonymous failed login) into
    // "field missing", and the replay would insert something different from
    // what happened.
    const original = entry({ tenantId: null, userId: null, actorEmail: null, targetId: null });
    const [back] = parseSpill(toSpillLine(original)).entries;
    expect(back).toEqual(original);
  });
});

describe('the recovery script', () => {
  const script = readFileSync(resolve(__dirname, '../../scripts/audit-replay.js'), 'utf8');

  it('keeps its copy of the parser in step with this module', () => {
    /*
     * audit-replay.js deliberately duplicates parseSpill: it is plain node, so
     * a recovery tool does not depend on the TypeScript build being healthy.
     * Duplication is the right call there and drift is the price, so the two
     * rules that matter are pinned here.
     */
    expect(script).toContain("typeof parsed?.action === 'string'");
    expect(script).toContain("typeof parsed?.outcome === 'string'");
    expect(script).toContain("contents.split('\\n')");
  });

  it('connects as the admin role, not the app role', () => {
    // hms_app is subject to RLS and these rows span hospitals — including
    // unattributed ones no tenant-scoped connection can insert.
    expect(script).toContain('DATABASE_URL_ADMIN');
  });

  it('checks for an existing row before inserting', () => {
    // Replay must be safe to run twice; a partial first run is the normal case.
    expect(script).toContain('SELECT 1 FROM audit_logs');
  });

  it('does not delete a file it could not fully read', () => {
    expect(script).toContain('corrupt === 0');
  });
});
