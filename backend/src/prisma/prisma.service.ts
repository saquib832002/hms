import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import {
  migrationsOnDisk,
  pendingMigrations,
  pendingMigrationWarning,
} from './pending-migrations';
import {
  GLOBAL_MODELS,
  TENANT_SCOPED_MODELS,
  currentScope,
  tenantStorage,
  withTenantWrites,
} from '../common/tenancy/tenant-context';

/**
 * The one place tenancy is applied to the database.
 *
 * Two responsibilities:
 *
 *  1. `forTenant()` opens a transaction and sets `app.tenant_id` on it, which
 *     is what every RLS policy reads. Nothing outside a `forTenant()` block can
 *     see tenant data at all — the policies evaluate against NULL and return
 *     no rows.
 *
 *  2. The provider in prisma.module.ts wraps this service in a Proxy so that
 *     `this.prisma.patient.findMany(...)` inside a request transparently uses
 *     the request's transaction. That is why none of the 133 existing query
 *     call sites had to change.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Prisma');

  async onModuleInit() {
    await this.$connect();
    await this.warnAboutPendingMigrations();
  }

  /**
   * Says once, at boot, that the database is behind the code.
   *
   * The Prisma client is generated from the schema; the database is changed by
   * a migration. Between those two steps the API queries columns that do not
   * exist, and the failure arrives as a 500 naming a column — which sends
   * whoever reads it looking at the feature that column belongs to rather than
   * at the one command nobody ran. That has happened three times on this
   * project. See `pending-migrations.ts`.
   *
   * Never fatal. A pending migration touching one feature must not take down
   * the screens that work without it — the same reasoning that makes a lapsed
   * subscription read-only rather than a lockout.
   */
  private async warnAboutPendingMigrations() {
    try {
      const onDisk = migrationsOnDisk(path.resolve(__dirname, '../../prisma/migrations'));
      if (onDisk.length === 0) return;

      const rows = await this.$queryRawUnsafe<{ migration_name: string }[]>(
        'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL',
      );
      const pending = pendingMigrations(
        onDisk,
        rows.map((r) => r.migration_name),
      );

      if (pending.length > 0) this.logger.error(pendingMigrationWarning(pending));
    } catch {
      /*
       * A database with no `_prisma_migrations` table has never been migrated
       * at all, and `db:setup` is the answer there — not this warning. Failing
       * silently is right: this check exists to make one specific confusion
       * legible, and must never itself become a reason the API will not start.
       */
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  /**
   * Runs `fn` with the tenant established for the whole transaction.
   *
   * SET LOCAL semantics, via set_config(..., true), are the point.
   *
   * A plain `SET` would persist for the life of the *connection*, and on a
   * pooled connection the next request — different user, different hospital —
   * would inherit it. That is verified behaviour, not caution: with plain SET,
   * rows stayed visible on the connection indefinitely after the request that
   * set it had finished.
   *
   * set_config is used rather than a literal `SET LOCAL` because it accepts a
   * bind parameter. `SET LOCAL` requires a literal, which would mean
   * interpolating a value into SQL.
   *
   * Note this means every tenant-scoped request holds a transaction open for
   * its duration. With PgBouncer, transaction pooling mode is required;
   * statement mode breaks this outright.
   */
  async forTenant<T>(tenantId: number, fn: () => Promise<T>): Promise<T> {
    return this.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${String(tenantId)}, true)`;
      return tenantStorage.run({ tenantId, tx: withTenantWrites(tx, tenantId) }, fn);
    });
  }

  /**
   * Escape hatch for work that legitimately spans tenants: the seed, platform
   * reporting, and migrations. Deliberately verbose to call and easy to grep
   * for, because "why is this unscoped" is a question worth being asked in
   * review every time it appears.
   *
   * It grants nothing by itself. Whether it can actually read across tenants
   * depends on the database role: as `hms_app` the policies still apply and
   * this returns nothing, which is the intended production behaviour.
   */
  get unscoped(): PrismaClient {
    // Never reached when the service is behind the tenant proxy — the proxy
    // intercepts `unscoped` and hands back the real instance directly. Kept so
    // the class is still usable unproxied, in tests and scripts.
    return this;
  }
}

/**
 * Routes model access to the request's tenant transaction when there is one.
 *
 * Without this, a service holding `PrismaService` would query outside the
 * transaction that carries `app.tenant_id`, and every RLS policy would evaluate
 * against an unset tenant. The failure is safe — zero rows — but total.
 */
export function createTenantAwarePrisma(base: PrismaService): PrismaService {
  return new Proxy(base, {
    get(target, prop, receiver) {
      const scope = currentScope();

      /*
       * `unscoped` returns the real client, not `this`.
       *
       * As a getter it returned `this`, and `this` through a proxy is whatever
       * the receiver happens to be — which meant callers got the proxy back and
       * then read a model off it, landing on Prisma's private state through the
       * wrong object and getting undefined. The symptom was
       * "Cannot read properties of undefined (reading 'findMany')", nowhere near
       * the cause.
       *
       * Returning the target explicitly removes the getter from the path
       * entirely, so there is no `this` left to be wrong.
       */
      if (prop === 'unscoped') return target;

      /*
       * Scoped models go through the request's transaction, as always.
       *
       * GLOBAL models now do too, and that is a bug fix rather than tidiness.
       *
       * THE DEADLOCK THIS CLOSES
       * ------------------------
       * `TenantInterceptor` wraps every authenticated request in an
       * interactive transaction, which holds ONE pool connection for the whole
       * request. Reading a global table off the base client — `tenants`, for
       * the timezone, on nearly every request — asked the same pool for a
       * SECOND connection while the first was still held.
       *
       * With Prisma's default pool (roughly 2×CPUs + 1), that is a
       * self-deadlock: once that many requests are in flight, each holds one
       * connection and waits for another that nobody can release. Requests
       * stall until the pool timeout fires, the 15-second auto-refresh on the
       * ward board and queue screens re-fires them, and the page never loads.
       * It looks like a slow query and is not one.
       *
       * Routing global models through the transaction is safe: they carry no
       * RLS policy, so `app.tenant_id` does not change what they return.
       * `unscoped` stays available for the handful of places that genuinely
       * need to escape the request's transaction — provisioning, and the
       * cross-tenant referral write.
       */
      if (
        scope &&
        typeof prop === 'string' &&
        (TENANT_SCOPED_MODELS.has(prop) || GLOBAL_MODELS.has(prop))
      ) {
        return (scope.tx as unknown as Record<string, unknown>)[prop];
      }

      /*
       * `$transaction` inside a request must reuse the tenant transaction, not
       * open a new one.
       *
       * Several services wrap multi-step writes in `this.prisma.$transaction`.
       * Left alone, that would start a second transaction on a different
       * connection — one where `app.tenant_id` was never set — so every query
       * inside it would match no RLS policy and silently return nothing. A
       * dispense would read an empty prescription and a payment would find no
       * invoice.
       *
       * Prisma has no nested transactions, and none are needed: the ambient
       * transaction already provides atomicity for the whole request.
       */
      if (scope && prop === '$transaction') {
        return (arg: unknown) =>
          typeof arg === 'function'
            ? (arg as (tx: unknown) => unknown)(scope.tx)
            : Promise.all(arg as Promise<unknown>[]);
      }

      /*
       * Deliberately NOT `Reflect.get(target, prop, receiver)`.
       *
       * Passing the proxy as the receiver makes `this` inside Prisma's model
       * getters the proxy rather than the real client. Prisma keeps its engine
       * and model state in private fields on the actual instance, so those
       * getters return undefined — and the failure surfaces far away, as
       * "Cannot read properties of undefined (reading 'create')" from whichever
       * code touched a model outside a tenant transaction. The audit writer
       * gets there first, because it runs from the exception filter.
       *
       * Omitting the receiver leaves `this` as the target, which is what every
       * getter here expects.
       */
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
