import { AsyncLocalStorage } from 'node:async_hooks';
import { Prisma } from '@prisma/client';

/**
 * The current hospital, for the duration of one request.
 *
 * WHY ASYNC LOCAL STORAGE AND NOT A PARAMETER
 * -------------------------------------------
 * The alternative is threading `tenantId` through every service method and on
 * to every one of the 133 Prisma call sites. That is a large, mechanical
 * change whose failure mode is silent: a call site that quietly keeps the old
 * signature still compiles, still returns rows, and returns the wrong
 * hospital's rows. ALS makes the tenant ambient, so there is no signature to
 * forget to update.
 *
 * The tenant is never taken from anything the client controls. It is read from
 * the authenticated user's own database row (see JwtStrategy) and installed
 * here by TenantInterceptor. A header or subdomain would be a one-line
 * cross-hospital breach.
 *
 * This is a convenience layer, not the security boundary. Postgres RLS is the
 * boundary — if this store is empty or wrong, the database returns nothing
 * rather than somebody else's data. See docs/adr-001-multi-tenancy.md.
 */
export interface TenantScope {
  tenantId: number;
  /**
   * The transaction the tenant was set on. Every query in this request must go
   * through it, because `app.tenant_id` is transaction-local — a query outside
   * this transaction has no tenant and therefore sees nothing.
   */
  tx: Prisma.TransactionClient;
}

export const tenantStorage = new AsyncLocalStorage<TenantScope>();

/** The active scope, or undefined outside a tenant-scoped request. */
export function currentScope(): TenantScope | undefined {
  return tenantStorage.getStore();
}

/**
 * The current hospital's id, for writes that must name it.
 *
 * Reads never need this — RLS filters them. Writes do, in two places the
 * runtime proxy cannot reach: nested relation creates
 * (`items: { create: [...] }`), which are not top-level `data`, and anywhere
 * the compiler demands the field because the column is NOT NULL.
 *
 * That the type system demands it is the useful part. A forgotten tenantId on
 * a write is a build error, not a runtime surprise.
 */
export function currentTenantId(): number {
  const scope = tenantStorage.getStore();
  if (!scope) {
    // Reached only if a write is attempted outside a tenant-scoped request.
    // Failing loudly beats inventing a tenant and writing a row into the wrong
    // hospital, which nothing downstream would detect.
    throw new Error(
      'No tenant in scope. A tenant-scoped write ran outside TenantInterceptor — ' +
        'if this is deliberate platform work, use prisma.unscoped and set tenantId explicitly.',
    );
  }
  return scope.tenantId;
}

/**
 * The models that carry `tenantId`, and therefore need it supplied on write.
 *
 * Kept as a plain list rather than derived from the DMMF at runtime so that
 * `tenant-models.spec.ts` can diff it against schema.prisma. A model added to
 * the schema and forgotten here would otherwise fail at runtime, on insert,
 * in production — the RLS WITH CHECK would reject it — rather than in CI.
 */
export const TENANT_SCOPED_MODELS = new Set([
  'user',
  'doctor',
  'department',
  'patient',
  'ward',
  'bed',
  'medicine',
  'stockBatch',
  'invoice',
  'appointment',
  'prescription',
  'admission',
  'medicalRecord',
  'auditLog',
  'allergy',
  'prescriptionItem',
  'vital',
  'medicationAdministration',
  'dispenseEvent',
  'dispenseLine',
  'payment',
  'invoiceItem',
  'userRoleAssignment',
]);

/** Models deliberately outside tenancy — both hang off User. */
export const GLOBAL_MODELS = new Set(['refreshToken', 'device', 'tenant']);

/**
 * The vendor's own tables. A third category, and it earns its place.
 *
 * `breakGlassGrant` carries a `tenantId` — it names the hospital a grant is
 * against — but it is emphatically NOT tenant-scoped:
 *
 *  - It must not be write-stamped from ambient scope. A grant is created while
 *    no hospital is in scope, from an id the vendor supplies deliberately.
 *  - It must not carry the generic policy. `tenantId = app_current_tenant()`
 *    would make each hospital able to read the grants opened against it, which
 *    sounds appealing and is the wrong mechanism — that belongs in their audit
 *    log, which they already get.
 *
 * Its policy is inverted instead: `app_current_tenant() IS NULL`, so these
 * tables are visible only outside a hospital request. Forcing them into
 * "scoped" or "global" would have meant either the wrong policy or a table with
 * `tenantId` and no policy at all — and the checks below exist precisely to
 * catch that second thing.
 */
export const PLATFORM_MODELS = new Set(['platformUser', 'breakGlassGrant']);

/** Write operations that must carry `tenantId` in their payload. */
const WRITE_OPS = new Set(['create', 'createMany', 'createManyAndReturn', 'upsert']);

/**
 * Wraps a transaction client so writes get `tenantId` without every call site
 * naming it.
 *
 * Reads need no help: RLS already filters them, so a `findMany` with no tenant
 * filter returns only this hospital's rows. Writes do need it, because a row
 * inserted without `tenantId` is NULL, and NULL fails the policy's WITH CHECK —
 * correct, but as a confusing runtime error rather than a working insert.
 *
 * Only fills in what is missing. An explicit `tenantId` is left alone so that
 * seeds and platform tooling, which legitimately write across tenants as a
 * superuser, keep working.
 */
export function withTenantWrites(
  tx: Prisma.TransactionClient,
  tenantId: number,
): Prisma.TransactionClient {
  return new Proxy(tx, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop !== 'string' || !TENANT_SCOPED_MODELS.has(prop)) return value;
      if (!value || typeof value !== 'object') return value;

      return new Proxy(value as Record<string, unknown>, {
        get(model, op, modelReceiver) {
          const fn = Reflect.get(model, op, modelReceiver);
          if (typeof op !== 'string' || !WRITE_OPS.has(op) || typeof fn !== 'function') {
            return fn;
          }
          return (args: Record<string, unknown> = {}) =>
            (fn as (a: unknown) => unknown).call(model, injectTenant(op, args, tenantId));
        },
      });
    },
  }) as Prisma.TransactionClient;
}

function injectTenant(
  op: string,
  args: Record<string, unknown>,
  tenantId: number,
): Record<string, unknown> {
  const stamp = (data: unknown): unknown => {
    if (Array.isArray(data)) return data.map(stamp);
    if (data && typeof data === 'object') {
      const row = data as Record<string, unknown>;
      return 'tenantId' in row ? row : { ...row, tenantId };
    }
    return data;
  };

  if (op === 'upsert') {
    return {
      ...args,
      create: stamp(args.create),
      // `update` is not stamped: the row already exists and RLS decides whether
      // this tenant may touch it. Stamping it would let a typo rewrite
      // ownership on a row we are allowed to see.
      update: args.update,
    };
  }
  return { ...args, data: stamp(args.data) };
}
