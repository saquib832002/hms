import { createTenantAwarePrisma, PrismaService } from './prisma.service';
import { tenantStorage, withTenantWrites } from '../common/tenancy/tenant-context';
import { Prisma } from '@prisma/client';

/**
 * Regression tests for the tenant proxy.
 *
 * Two production failures came from this file, both of the same shape: a proxy
 * `get` trap that returned the wrong `this`, so Prisma's model accessors
 * resolved against the proxy instead of the real client and came back
 * undefined. The errors surfaced far away — "Cannot read properties of
 * undefined (reading 'create')" in the audit writer, then the same for
 * 'findMany' in login — and neither named the proxy.
 *
 * These assert the proxy's contract directly, with a stub standing in for the
 * client, so the behaviour is pinned without needing a database.
 */

interface StubModel {
  findMany: jest.Mock;
  create: jest.Mock;
}

function stubClient() {
  const model = (): StubModel => ({ findMany: jest.fn(), create: jest.fn() });
  const target = {
    user: model(),
    patient: model(),
    auditLog: model(),
    // A getter that returns `this`, exactly as PrismaService.unscoped does.
    get unscoped() {
      return this;
    },
    $connect: jest.fn(),
    $transaction: jest.fn(),
    notAModel: 'plain value',
  };
  return target as unknown as PrismaService & typeof target;
}

describe('tenant-aware Prisma proxy', () => {
  describe('outside a tenant scope', () => {
    it('passes model access straight through to the real client', () => {
      const target = stubClient();
      const proxy = createTenantAwarePrisma(target);
      expect(proxy.user).toBe(target.user);
      expect(typeof proxy.user.findMany).toBe('function');
    });

    it('returns the REAL client from unscoped, never the proxy', () => {
      // The bug: as a getter returning `this`, `this` was the receiver — the
      // proxy — so callers got the proxy back and read models off it.
      const target = stubClient();
      const proxy = createTenantAwarePrisma(target);

      expect(proxy.unscoped).toBe(target);
      expect(proxy.unscoped).not.toBe(proxy);
    });

    it('keeps models reachable through unscoped', () => {
      // This is the exact expression that threw in AuthService.findLoginCandidate
      // and AuditService.write.
      const target = stubClient();
      const proxy = createTenantAwarePrisma(target);

      expect(proxy.unscoped.user).toBeDefined();
      expect(typeof proxy.unscoped.user.findMany).toBe('function');
      expect(typeof (proxy.unscoped as unknown as typeof target).auditLog.create).toBe('function');
    });

    it('does not disturb non-model properties', () => {
      const target = stubClient();
      const proxy = createTenantAwarePrisma(target);
      expect((proxy as unknown as typeof target).notAModel).toBe('plain value');
      expect(typeof proxy.$connect).toBe('function');
    });
  });

  describe('inside a tenant scope', () => {
    const tx = {
      user: { findMany: jest.fn(), create: jest.fn() },
      patient: { findMany: jest.fn(), create: jest.fn() },
    } as unknown as Prisma.TransactionClient;

    const run = <T>(fn: () => T): T =>
      tenantStorage.run({ tenantId: 7, tx: withTenantWrites(tx, 7) }, fn);

    it('routes tenant-scoped models to the transaction', () => {
      const target = stubClient();
      const proxy = createTenantAwarePrisma(target);

      run(() => {
        // Not the target's model — the transaction's, so the query carries
        // app.tenant_id and RLS sees a tenant.
        expect(proxy.patient).not.toBe(target.patient);
      });
    });

    it('still returns the real client from unscoped', () => {
      // Even mid-request, `unscoped` must mean unscoped. Login and the audit
      // writer rely on this while a scope may be active elsewhere.
      const target = stubClient();
      const proxy = createTenantAwarePrisma(target);

      run(() => {
        expect(proxy.unscoped).toBe(target);
        expect(proxy.unscoped.user).toBe(target.user);
      });
    });

    it('reuses the tenant transaction rather than opening a new one', () => {
      // A fresh $transaction would run without app.tenant_id set, and every
      // query inside it would match no policy and silently return nothing.
      const target = stubClient();
      const proxy = createTenantAwarePrisma(target);

      run(() => {
        const cb = jest.fn();
        (proxy.$transaction as unknown as (f: unknown) => unknown)(cb);
        expect(target.$transaction).not.toHaveBeenCalled();
        expect(cb).toHaveBeenCalledTimes(1);
      });
    });
  });
});
