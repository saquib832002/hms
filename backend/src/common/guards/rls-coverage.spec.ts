import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * `prisma/rls-coverage.js` checks a live database against the rules in
 * `prisma/rls/tenant-isolation.sql`. Both hold the list of *platform* tables —
 * the ones carrying the INVERTED policy, visible only when no hospital is in
 * scope — and they must agree.
 *
 * They cannot be derived from one another. The SQL is read by Postgres and the
 * checker is read by Node, neither can import the other, and the checker
 * deliberately has no dependency on the application build so that it still
 * runs when the API does not. So the copies are compared instead, exactly as
 * `types.ts` is compared between the two clients.
 *
 * The direction that matters is a table added to the SQL and not to the
 * checker: `break_glass_grants` and `tenant_applications` both have a
 * `tenantId`, so the checker's general rule — a tenantId column means a
 * tenant-scoped policy — applies cleanly to them and is WRONG. It would
 * report the correct inverted policy as a fault, and a checker that cries
 * wolf is answered by not running it.
 */
describe('rls-coverage.js and tenant-isolation.sql', () => {
  const root = resolve(__dirname, '../../../prisma');
  const sql = readFileSync(resolve(root, 'rls/tenant-isolation.sql'), 'utf8');
  const checker = readFileSync(resolve(root, 'rls-coverage.js'), 'utf8');

  const names = (block: string) => [...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();

  it('name the same platform tables', () => {
    const inSql = sql.match(/platform_tables\s+text\[\]\s*:=\s*ARRAY\[([\s\S]*?)\]/);
    const inJs = checker.match(/const PLATFORM_TABLES = \[([\s\S]*?)\];/);

    expect(inSql).not.toBeNull();
    expect(inJs).not.toBeNull();

    const fromSql = names(inSql![1]);
    const fromJs = names(inJs![1]);

    expect(fromJs).toEqual(fromSql);
    // A guard over two empty lists would pass and mean nothing.
    expect(fromSql.length).toBeGreaterThan(3);
  });

  it('derives the tenant-scoped expectation from the column, not from a list', () => {
    /*
     * The scoped list in the SQL is enumerated and long. The checker must NOT
     * hold a copy of it: it would go stale in the silent direction, where a new
     * table missing from the list reads as "no policy expected" rather than as
     * a gap — which is the failure `db:doctor`'s count(*) > 0 already had.
     */
    expect(checker).toMatch(/column_name\s*=\s*'tenantId'/);
    expect(checker).not.toMatch(/const\s+(TENANT_SCOPED|SCOPED_TABLES)\s*=\s*\[/);
  });

  it('checks ENABLE and FORCE, not merely the presence of a policy', () => {
    // Without FORCE the table owner bypasses the policy, so a table can carry
    // a correct policy and still be unprotected against the owner connection.
    expect(checker).toMatch(/relforcerowsecurity/);
    expect(checker).toMatch(/relrowsecurity/);
  });

  it('connects as the owner rather than as the constrained role', () => {
    expect(checker).toMatch(/DATABASE_URL_ADMIN/);
    // Reading pg_policies as hms_app would be a check conducted through the
    // very restrictions it is inspecting.
    expect(checker).not.toMatch(/fromFile\.DATABASE_URL\b/);
  });
});
