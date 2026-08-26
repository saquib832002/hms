import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { GLOBAL_MODELS, PLATFORM_MODELS, TENANT_SCOPED_MODELS } from './tenant-context';

/**
 * Static guards on tenancy, in the pattern that has worked in this repo.
 *
 * `access-matrix.spec.ts` and `endpoint-coverage.spec.ts` each caught a real
 * violation the day they were written. These do the same job for the property
 * that now matters most: a model holding patient data must carry `tenantId`,
 * and a table carrying `tenantId` must have an RLS policy.
 *
 * The failure mode being guarded against is not a wrong function. It is a model
 * added six months from now that nobody remembers to classify — which would
 * read fine, pass every other test, and be visible to every hospital.
 */

const SCHEMA = resolve(__dirname, '../../../prisma/schema.prisma');
const RLS = resolve(__dirname, '../../../prisma/rls/tenant-isolation.sql');

const schema = readFileSync(SCHEMA, 'utf8');
const rls = readFileSync(RLS, 'utf8');

/** Model name → body, straight from the schema. */
function models(): Map<string, string> {
  const out = new Map<string, string>();
  const re = /^model (\w+) \{([\s\S]*?)^\}/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(schema))) out.set(m[1], m[2]);
  return out;
}

const ALL = models();
const camel = (s: string) => s[0].toLowerCase() + s.slice(1);
const tableOf = (body: string) => body.match(/@@map\("(\w+)"\)/)?.[1];

describe('tenancy coverage', () => {
  it('parses the schema', () => {
    // Guards against every assertion below passing vacuously because the
    // regex stopped matching after a formatting change.
    expect(ALL.size).toBeGreaterThan(20);
    expect(ALL.has('Tenant')).toBe(true);
  });

  it('classifies every model as scoped or deliberately global', () => {
    const classified = new Set([
      ...[...TENANT_SCOPED_MODELS],
      ...[...GLOBAL_MODELS],
      ...[...PLATFORM_MODELS],
    ]);
    const unclassified = [...ALL.keys()]
      .map(camel)
      .filter((m) => !classified.has(m));

    // A new model must be a deliberate decision, not an oversight. If this
    // fails, add it to TENANT_SCOPED_MODELS or justify it in GLOBAL_MODELS.
    expect(unclassified).toEqual([]);
  });

  it('gives every tenant-scoped model a tenantId field', () => {
    const missing = [...ALL.entries()]
      .filter(([name]) => TENANT_SCOPED_MODELS.has(camel(name)))
      .filter(([, body]) => !/^\s*tenantId\s+Int/m.test(body))
      .map(([name]) => name);

    expect(missing).toEqual([]);
  });

  it('keeps the global models free of tenantId', () => {
    // A tenantId here would imply a policy that does not exist, which is the
    // more dangerous direction: it looks scoped and is not.
    const unexpected = [...ALL.entries()]
      .filter(([name]) => GLOBAL_MODELS.has(camel(name)) && name !== 'Tenant')
      .filter(([, body]) => /^\s*tenantId\s+Int/m.test(body))
      .map(([name]) => name);

    expect(unexpected).toEqual([]);
  });

  describe('the vendor tables', () => {
    it('are classified in exactly one category', () => {
      // Three sets that overlap would let a model be "handled" by one check and
      // exempted by another, which is how a hole opens without anyone editing a
      // policy.
      for (const m of PLATFORM_MODELS) {
        expect(TENANT_SCOPED_MODELS.has(m)).toBe(false);
        expect(GLOBAL_MODELS.has(m)).toBe(false);
      }
    });

    it('are never write-stamped from ambient tenant scope', () => {
      /*
       * withTenantWrites() stamps tenantId onto creates for TENANT_SCOPED_MODELS.
       * A grant must carry the hospital the vendor deliberately named, not
       * whichever one happened to be in scope — and it is created with none in
       * scope at all, so a stamp would write NULL over an explicit value.
       */
      expect(TENANT_SCOPED_MODELS.has('breakGlassGrant')).toBe(false);
    });

    it('carry the inverted policy, not the generic one', () => {
      /*
       * The assertion that matters, and the one a reader would otherwise have
       * to take on trust from a comment.
       *
       * break_glass_grants has a tenantId, so the generic loop's predicate
       * would apply cleanly and be wrong: it would show each hospital the
       * grants opened against it, out of a table that also names every other
       * hospital's grants to the vendor. The predicate must be the inverse.
       */
      for (const table of ['platform_users', 'break_glass_grants']) {
        expect(rls).toContain(`'${table}'`);
      }
      expect(rls).toContain("USING (app_current_tenant() IS NULL)");

      // And the generic loop must not also list them, which would create a
      // second policy on the same table — Postgres ORs permissive policies
      // together, so the stricter one would stop being the answer.
      const genericBlock = rls.slice(
        rls.indexOf('scoped text[] := ARRAY['),
        rls.indexOf('END $$;', rls.indexOf('scoped text[] := ARRAY[')),
      );
      expect(genericBlock).not.toContain('break_glass_grants');
      expect(genericBlock).not.toContain('platform_users');
    });

    it('prove the policy at apply time rather than asserting it in prose', () => {
      // The live run found three bugs that every unit test missed, all of them
      // wrong assumptions about runtime behaviour. So the SQL checks itself
      // against a row it inserts, in both directions.
      expect(rls).toContain('__rls_probe__@invalid');
      expect(rls).toContain('could never sign in');
    });
  });

  it('gives every tenant-scoped table an RLS policy', () => {
    const missing = [...ALL.entries()]
      .filter(([name]) => TENANT_SCOPED_MODELS.has(camel(name)))
      .map(([, body]) => tableOf(body))
      .filter((table): table is string => Boolean(table))
      .filter((table) => !rls.includes(`'${table}'`) && !rls.includes(` ${table} `));

    // A table with tenantId and no policy is worse than one without either —
    // it reads as scoped in review and is wide open at runtime.
    expect(missing).toEqual([]);
  });

  it('forces RLS rather than merely enabling it', () => {
    // Without FORCE the table owner bypasses every policy. If the API ever
    // connects as the migration user, isolation silently disappears.
    expect(rls).toContain('FORCE  ROW LEVEL SECURITY');
    expect(rls).toContain('WITH CHECK');
  });

  it('wraps the tenant setting in nullif', () => {
    // Without nullif, `''::int` throws on the first query after a SET LOCAL
    // transaction commits — a 500 on an unrelated request sharing the pooled
    // connection. Verified against PostgreSQL 14; see docs/adr-001.
    expect(rls).toMatch(/nullif\(\s*current_setting\('app\.tenant_id', true\)/);
  });

  it('never uses plain SET for the tenant', () => {
    // `SET` persists for the life of the connection; on a pool the next
    // request inherits the previous hospital. Only SET LOCAL / set_config(…,
    // true) is transaction-scoped.
    const service = readFileSync(resolve(__dirname, '../../prisma/prisma.service.ts'), 'utf8');
    expect(service).toContain("set_config('app.tenant_id'");
    expect(service).toMatch(/set_config\([^)]*true\)/);
    expect(service).not.toMatch(/\$executeRaw`\s*SET\s+app\.tenant_id/i);
  });
});

describe('the four global unique constraints became composites', () => {
  // Each of these would otherwise mean "only one hospital in the world may
  // have a Cardiology department", and the second tenant's seed fails.
  it.each([
    ['User', 'email'],
    ['Department', 'name'],
    ['Ward', 'name'],
    ['Medicine', 'name'],
  ])('%s.%s is unique per tenant, not globally', (model, field) => {
    const body = ALL.get(model)!;
    expect(body).toContain(`@@unique([tenantId, ${field}])`);

    const fieldLine = body
      .split('\n')
      .find((l) => new RegExp(`^\\s*${field}\\s+String`).test(l));
    expect(fieldLine).toBeDefined();
    expect(fieldLine).not.toContain('@unique');
  });
});

describe('audit logs are the documented exception', () => {
  it('allows a null tenant, because an anonymous failed login has none', () => {
    const body = ALL.get('AuditLog')!;
    expect(body).toMatch(/^\s*tenantId\s+Int\?/m);
  });

  it('still refuses to show one hospital another hospital rows', () => {
    // The read side is unchanged: `tenantId = app_current_tenant()` is never
    // true for a NULL row, so unattributed entries are invisible to tenants.
    expect(rls).toContain('CREATE POLICY tenant_isolation ON audit_logs');
    expect(rls).toMatch(/USING\s+\("tenantId" = app_current_tenant\(\)\)/);
    expect(rls).toContain('"tenantId" IS NULL');
  });
});
