import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { AuditOutcome, Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  MAX_ATTEMPTS,
  SpilledEntry,
  backoffMs,
  overflowAction,
  shouldRetry,
  toSpillLine,
} from './audit-queue';

export interface AuditEntry {
  /**
   * Which hospital. Null for events that belong to none — a failed login with
   * an unknown address has no authenticated user and therefore no tenant, and
   * that row is one of the most useful in the table.
   */
  tenantId?: number | null;
  userId?: number | null;
  actorEmail?: string | null;
  actorRole?: UserRole | null;
  action: string;
  method?: string;
  path?: string;
  targetType?: string | null;
  targetId?: number | null;
  outcome: AuditOutcome;
  statusCode?: number;
  ipAddress?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

/** Where entries go when the database will not take them. */
export const SPILL_FILE = resolve(process.cwd(), 'var', 'audit-spill.jsonl');

/**
 * Append-only audit trail.
 *
 * `record()` is still non-blocking, and that has not changed: a slow or failing
 * audit insert must never slow down or fail the clinical action it describes. A
 * nurse must still be able to save vitals if the audit table is having a bad
 * day.
 *
 * What changed is what happens after. A floating promise meant one transient
 * error lost the row with nothing but a log line to show for it — and since
 * denials started flowing through here, a lost row is a lost security event
 * rather than a missing read receipt.
 *
 * Now:
 *   - entries go into a bounded in-memory queue, drained by a single loop;
 *   - a failed insert is retried with backoff (see `audit-queue.ts`);
 *   - anything that still will not write is appended to a spill file, never
 *     dropped;
 *   - shutdown drains the queue before the process exits.
 *
 * WHAT THIS STILL IS NOT
 * ----------------------
 * Durable across a hard kill. Entries live in memory for the few milliseconds
 * between `record()` and the insert, and `kill -9` loses them. Closing that
 * window means writing to disk before acknowledging the request, and on a
 * single machine the disk and the database fail together anyway. Stated plainly
 * here because "we added a queue" is the kind of change that gets remembered as
 * "audit writes are safe now".
 *
 * NO-LOG-NO-LOOK WAS CONSIDERED AND NOT DONE
 * ------------------------------------------
 * A stricter posture exists: refuse to serve PHI that cannot be logged. It is
 * defensible for reads — an unlogged lookup of a patient is exactly what the
 * trail is for. It is indefensible for clinical writes, where refusing to
 * record vitals because the audit table is unwell is the more dangerous
 * failure. Splitting the two is a real design choice and is deliberately not
 * made silently; it is not built, rather than half-built behind an unused flag.
 */
@Injectable()
export class AuditService implements OnApplicationShutdown {
  private readonly logger = new Logger('Audit');

  private readonly queue: AuditEntry[] = [];
  /**
   * The in-flight drain, or null.
   *
   * A boolean flag was the first version and was wrong in a way worth keeping a
   * note about: `drain()` returned immediately when a drain was already
   * running, so `onApplicationShutdown` awaited a resolved no-op and then
   * spilled everything still queued. A clean SIGTERM during normal traffic
   * produced a spill file needing manual replay, while the code read as though
   * it drained. Holding the promise is what makes "wait for the drain" mean it.
   */
  private drainPromise: Promise<void> | null = null;
  private shuttingDown = false;

  /** Counters, surfaced on shutdown so a bad night leaves a summary. */
  private spilled = 0;
  private retried = 0;

  constructor(private prisma: PrismaService) {}

  /**
   * Enqueue and return. Never throws, never awaits the database.
   *
   * Callers include `AllExceptionsFilter`, which runs while a request is
   * already failing. Anything that can throw here would replace a useful error
   * with a confusing one.
   */
  record(entry: AuditEntry): void {
    if (overflowAction(this.queue.length) === 'spill') {
      /*
       * The queue is full, which means the database has been refusing writes
       * for a while. Spilling the incoming entry keeps memory bounded and
       * preserves the order of everything already queued.
       *
       * Deliberately not "drop the oldest": the oldest entry has survived the
       * longest and is the most likely to be the one someone comes looking for.
       */
      this.spill(entry, 'queue full — database not accepting writes');
      return;
    }

    this.queue.push(entry);
    void this.drain();
  }

  /**
   * Single drain loop.
   *
   * One at a time rather than `Promise.all`, because the failure this runs into
   * is usually pool exhaustion — and firing a thousand concurrent inserts at an
   * unhealthy pool is how a blip becomes an outage.
   */
  private drain(): Promise<void> {
    // Returns the *existing* drain rather than a resolved no-op, so a caller
    // that awaits this actually waits for the queue to empty.
    if (this.drainPromise) return this.drainPromise;

    this.drainPromise = this.runDrain().finally(() => {
      this.drainPromise = null;

      /*
       * An entry enqueued after the loop's last length check but before this
       * runs would otherwise sit until the next record() happened to arrive —
       * and on a quiet system the next one might be a long time coming.
       */
      if (this.queue.length > 0 && !this.shuttingDown) void this.drain();
    });

    return this.drainPromise;
  }

  private async runDrain(): Promise<void> {
    while (this.queue.length > 0) {
      const entry = this.queue.shift() as AuditEntry;
      await this.writeWithRetry(entry);
    }
  }

  private async writeWithRetry(entry: AuditEntry): Promise<void> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        await this.write(entry);
        if (attempt > 1) this.retried += 1;
        return;
      } catch (err) {
        lastError = err;

        if (!shouldRetry(attempt)) break;

        // During shutdown there is no time to back off. One more immediate
        // attempt, then spill — a deploy must not hang on a sick database.
        if (this.shuttingDown) continue;

        await sleep(backoffMs(attempt));
      }
    }

    const reason =
      lastError instanceof Error ? `${lastError.name}: ${lastError.message}` : String(lastError);

    this.logger.error(
      `AUDIT WRITE FAILED after ${MAX_ATTEMPTS} attempts, spilling to disk: ` +
        `${entry.action} (${entry.outcome}) req:${entry.requestId}`,
      lastError instanceof Error ? lastError.stack : undefined,
    );

    this.spill(entry, reason);
  }

  /**
   * Last resort. The row is not lost, it is just not in the table yet.
   *
   * Synchronous on purpose: this runs when the async path has already failed,
   * and during shutdown, where an unawaited write is a lost write. It is also
   * rare by construction — a normal run never reaches it.
   *
   * The file holds the same fields as `audit_logs`: who, what, when, which
   * record. That is access metadata, not clinical content — no names, no
   * diagnoses, no medicines. It is still sensitive, and belongs inside the same
   * trust boundary as the database (rule 6: real PHI means BAA-covered
   * hosting). Replay it with `npm run audit:replay`.
   */
  private spill(entry: AuditEntry, reason: string): void {
    this.spilled += 1;

    const line: SpilledEntry = {
      ...this.toRow(entry),
      occurredAt: new Date().toISOString(),
      spillReason: reason.slice(0, 300),
    };

    try {
      mkdirSync(dirname(SPILL_FILE), { recursive: true });
      appendFileSync(SPILL_FILE, toSpillLine(line), 'utf8');
    } catch (err) {
      // Both sinks are gone. Nothing left but the process log, which at least
      // a log shipper may have taken off the machine already.
      this.logger.error(
        `AUDIT ENTRY LOST — database and spill file both unavailable: ${JSON.stringify(line)}`,
        err instanceof Error ? err.stack : undefined,
      );
    }
  }

  /**
   * Drain before the process exits.
   *
   * Nest calls this on SIGTERM/SIGINT because `main.ts` enables shutdown hooks.
   * Bounded by a timeout: a deploy that hangs waiting on an unhealthy database
   * is worse than a spill file, and anything still queued when time runs out
   * goes to disk rather than into the void.
   */
  async onApplicationShutdown(signal?: string): Promise<void> {
    this.shuttingDown = true;

    const pending = this.queue.length;
    if (pending > 0) {
      this.logger.log(`Draining ${pending} audit entries before shutdown (${signal ?? 'exit'})`);
    }

    // Cancellable, so a drain that finishes in 5ms does not hold the process
    // open for the remaining 4,995. An uncleared timer here would make every
    // clean shutdown look like a hung one.
    await raceWithTimeout(this.drain(), 5_000);

    // Whatever did not make it in time is spilled rather than discarded.
    while (this.queue.length > 0) {
      this.spill(this.queue.shift() as AuditEntry, 'shutdown drain timed out');
    }

    if (this.spilled > 0 || this.retried > 0) {
      this.logger.warn(
        `Audit summary: ${this.retried} entries needed a retry, ${this.spilled} spilled to ${SPILL_FILE}. ` +
          `Run \`npm run audit:replay\` to load the spill file into the database.`,
      );
    }
  }

  /**
   * Queue depth and counters.
   *
   * Surfaced through the grant-gated platform diagnostics, not `/health`:
   * `/health` is unauthenticated by definition and deliberately reports nothing
   * but up/down, and "this deployment has 400 audit entries it could not
   * write" is exactly the operational detail it must not hand to the world.
   *
   * `spilled > 0` is the number worth alerting on — it means rows exist on disk
   * that are not in the trail yet.
   */
  stats() {
    return { queued: this.queue.length, spilled: this.spilled, retried: this.retried };
  }

  /**
   * Writes the row on its own connection, outside the request's transaction.
   *
   * Two reasons, both discovered by working through the failure paths:
   *
   *  1. A failure audit is produced by AllExceptionsFilter, which runs after
   *     the tenant transaction has already rolled back. Writing "through" that
   *     transaction would either fail or vanish with the rollback — and the
   *     rows most worth keeping are exactly the ones attached to a failure.
   *
   *  2. Even for a success, an audit row that rolls back with the request it
   *     describes is not an audit trail. "Someone tried and it failed" is the
   *     record; discarding it because the attempt failed defeats the purpose.
   *
   * So the tenant is re-established explicitly for this insert, rather than
   * inherited. Unattributed rows (an anonymous failed login) are written with
   * no tenant at all, which the audit_logs policy permits and no hospital can
   * read back.
   */
  private async write(entry: AuditEntry): Promise<void> {
    const data = this.toRow(entry);

    /*
     * Throws on failure rather than swallowing.
     *
     * It used to catch and log, which is what made the old fire-and-forget path
     * silent: the caller could not tell a written row from a lost one because
     * nothing ever came back. Retry and spill both depend on this rejecting.
     */
    if (entry.tenantId == null) {
      /*
       * createMany, not create — and the difference is not stylistic.
         *
       * Prisma's `create` issues INSERT ... RETURNING, and Postgres applies a
       * policy's USING clause to the row a RETURNING clause hands back. For an
       * unattributed row `"tenantId" = app_current_tenant()` is NULL rather
       * than true, so the insert is accepted by WITH CHECK and then rejected
       * on the way out: "new row violates row-level security policy".
       *
       * `createMany` emits a plain INSERT with no RETURNING, so only WITH
       * CHECK applies — which is what permits the NULL tenant.
       *
       * The alternative, widening USING to allow NULL, would let every
       * hospital read every other hospital's unattributed rows. The read side
       * stays closed; only the write path changes.
       */
      await this.prisma.unscoped.auditLog.createMany({ data: [data] });
      return;
    }

    // Inside forTenant the proxy resolves `auditLog` to that transaction's
    // client, so this insert carries app.tenant_id and satisfies the policy.
    await this.prisma.forTenant(entry.tenantId, () => this.prisma.auditLog.create({ data }));
  }

  private toRow(entry: AuditEntry) {
    return {
      tenantId: entry.tenantId ?? null,
      userId: entry.userId ?? null,
      actorEmail: entry.actorEmail ?? null,
      actorRole: entry.actorRole ?? null,
      action: entry.action,
      method: entry.method,
      path: entry.path,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      outcome: entry.outcome,
      statusCode: entry.statusCode,
      ipAddress: entry.ipAddress ?? null,
      userAgent: entry.userAgent?.slice(0, 255) ?? null,
      requestId: entry.requestId ?? null,
    };
  }

  async find(params: {
    userId?: number;
    outcome?: AuditOutcome;
    targetType?: string;
    targetId?: number;
    from?: Date;
    to?: Date;
    page: number;
    limit: number;
  }) {
    const where: Prisma.AuditLogWhereInput = {
      ...(params.userId ? { userId: params.userId } : {}),
      ...(params.outcome ? { outcome: params.outcome } : {}),
      ...(params.targetType ? { targetType: params.targetType } : {}),
      ...(params.targetId ? { targetId: params.targetId } : {}),
      ...(params.from || params.to
        ? { createdAt: { ...(params.from ? { gte: params.from } : {}), ...(params.to ? { lte: params.to } : {}) } }
        : {}),
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (params.page - 1) * params.limit,
        take: params.limit,
        include: { user: { select: { id: true, fullName: true, email: true, role: true } } },
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return { data, meta: { total, page: params.page, limit: params.limit } };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Resolves when `work` settles or `ms` elapses, whichever comes first. */
function raceWithTimeout(work: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<void>((r) => {
    timer = setTimeout(r, ms);
  });
  // `finally` runs on both branches, so the timer is cleared whether the drain
  // won or lost.
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}
