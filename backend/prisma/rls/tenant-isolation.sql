-- ═══════════════════════════════════════════════════════════════════════════
-- Row-Level Security: tenant isolation
--
-- This file is the boundary between hospitals. The `tenantId` column and the
-- application's WHERE clauses are the *first* layer; this is the one that holds
-- when the first layer is forgotten. See docs/adr-001-multi-tenancy.md.
--
-- Idempotent — safe to re-run. Apply after `prisma migrate dev`, because
-- Prisma cannot express policies in schema.prisma and will not recreate them.
--
--   npm run db:rls
--
-- ⚠ SUPERUSERS ALWAYS BYPASS RLS, FORCE OR NOT.
--    If the API connects as `postgres`, every policy below is decorative and
--    tenant isolation does not exist. The application MUST connect as the
--    non-superuser role created here. This is the single most important line
--    in the file.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. the application role ────────────────────────────────────────────────
-- Deliberately NOSUPERUSER and without BYPASSRLS. Migrations and the seed keep
-- running as the owner/superuser, which is why they can still write across
-- tenants; the API cannot.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hms_app') THEN
    CREATE ROLE hms_app LOGIN PASSWORD 'admin' NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

-- CONNECT on the database itself. PUBLIC usually has this by default, but not
-- on a server where it has been revoked — and the failure is Prisma's P1010
-- ("User was denied access"), which reads like a password problem and is not.
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO hms_app', current_database());
END $$;

GRANT USAGE ON SCHEMA public TO hms_app;
-- Postgres 15 removed PUBLIC's default rights on the public schema, so on a
-- newer server the USAGE grant above is doing real work rather than restating
-- a default.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO hms_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO hms_app;
-- Future tables created by later migrations inherit these grants.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hms_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO hms_app;

-- ── 2. the tenant accessor ─────────────────────────────────────────────────
-- The nullif() is not cosmetic. After a `SET LOCAL` transaction commits, the
-- setting is '' rather than unset, and ''::int raises
--   invalid input syntax for type integer: ""
-- on the *next* query to reuse that pooled connection — a 500 on an unrelated
-- request, which is a miserable way to discover the problem. nullif() turns
-- that back into NULL, so the policy evaluates false and returns zero rows.
CREATE OR REPLACE FUNCTION app_current_tenant() RETURNS int
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::int $$;

COMMENT ON FUNCTION app_current_tenant() IS
  'Current tenant for RLS, from the app.tenant_id session variable. NULL when unset, which denies everything.';

-- ── 3. policies ────────────────────────────────────────────────────────────
-- One per tenant-scoped table. USING filters reads; WITH CHECK blocks writes
-- that would label a row with somebody else's tenant.
--
-- FORCE makes the table owner subject to the policy too. It does not stop a
-- superuser — nothing does — but it removes the "we accidentally ran the API as
-- the migration user" failure mode.
DO $$
DECLARE
  t text;
  scoped text[] := ARRAY[
    'users', 'doctors', 'departments', 'patients', 'wards', 'beds',
    'medicines', 'stock_batches', 'invoices', 'appointments', 'prescriptions',
    'admissions', 'medical_records', 'allergies',
    'prescription_items', 'vitals', 'medication_administrations',
    'dispense_events', 'dispense_lines', 'payments', 'invoice_items',
    -- Who may act as what. Scoped like everything else: one hospital's role
    -- grants are none of another's business, and an unscoped row here would be
    -- a grant visible across tenants.
    'user_role_assignments'
  ];
BEGIN
  FOREACH t IN ARRAY scoped LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I '
      'USING ("tenantId" = app_current_tenant()) '
      'WITH CHECK ("tenantId" = app_current_tenant())', t);
  END LOOP;
END $$;

-- audit_logs is the one exception, and it is deliberate.
--
-- A failed login with an unknown email belongs to no hospital: there is no
-- authenticated user, and that row is exactly the one a security review wants.
-- So tenantId is nullable here, and the write side must accept NULL.
--
-- Reads are unchanged — `tenantId = app_current_tenant()` is never true for a
-- NULL row, so no hospital can see another's entries or the unattributed ones.
-- Those are visible only to platform tooling connecting as the owner.
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON audit_logs;
CREATE POLICY tenant_isolation ON audit_logs
  USING      ("tenantId" = app_current_tenant())
  WITH CHECK ("tenantId" = app_current_tenant() OR "tenantId" IS NULL);

-- ── 3b. authentication has to happen before a tenant is known ──────────────
--
-- THE CHICKEN AND EGG
-- Every policy above keys on app.tenant_id. The tenant comes from the user's
-- row. But finding that row *is* the login, and at that moment no tenant is
-- set — so `users` is invisible and no one can ever sign in. The same applies
-- to JwtStrategy, which re-reads the user on every request before the tenant
-- transaction is opened.
--
-- These two functions are the only sanctioned way across that boundary. They
-- are SECURITY DEFINER, so they run as the owner and see past RLS, and they
-- return *nothing but identifiers* — no name, no password hash, no PHI. The
-- caller then opens a normal tenant transaction and reads the row through the
-- policies like anything else.
--
-- search_path is pinned: a SECURITY DEFINER function without it can be
-- hijacked by a caller-controlled search_path resolving `users` to another
-- table.

CREATE OR REPLACE FUNCTION app_login_lookup(p_email text)
  RETURNS TABLE (user_id int, tenant_id int)
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  STABLE
  AS $$
    SELECT u.id, u."tenantId"
    FROM users u
    JOIN tenants t ON t.id = u."tenantId"
    WHERE lower(u.email) = lower(p_email)
      AND t."isActive"
    -- Bounded: an address existing at more than a couple of hospitals is a
    -- case the caller refuses to guess at anyway.
    LIMIT 3
  $$;

COMMENT ON FUNCTION app_login_lookup(text) IS
  'Resolves an email to (user id, tenant id) across tenants, for login only. Returns no personal data.';

-- bigint, not int, and there is deliberately only ONE of these.
--
-- Drivers disagree about how to bind a JS number: Prisma's library engine
-- sends bigint, its driver-adapter build sends int. A bigint parameter accepts
-- both, because Postgres widens int to bigint implicitly. Defining an overload
-- for each instead makes an uncast literal ambiguous —
-- "function app_user_tenant(unknown) is not unique" — which is a worse failure
-- than the one it was meant to fix.
DROP FUNCTION IF EXISTS app_user_tenant(int);

CREATE OR REPLACE FUNCTION app_user_tenant(p_user_id bigint)
  RETURNS int
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  STABLE
  AS $$
    SELECT u."tenantId"
    FROM users u
    JOIN tenants t ON t.id = u."tenantId"
    WHERE u.id = p_user_id
      AND u."isActive"
      AND t."isActive"
  $$;

COMMENT ON FUNCTION app_user_tenant(bigint) IS
  'Which hospital a user belongs to, for establishing the tenant on an authenticated request.';

REVOKE ALL ON FUNCTION app_login_lookup(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_user_tenant(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_login_lookup(text) TO hms_app;
GRANT EXECUTE ON FUNCTION app_user_tenant(bigint) TO hms_app;

-- ── 3c. the vendor's own tables ────────────────────────────────────────────
--
-- platform_users and break_glass_grants belong to the vendor, not to any
-- hospital. They still need a policy, and the interesting part is that it is
-- the *inverse* of every policy above.
--
--   USING (app_current_tenant() IS NULL)
--
-- Read as: visible only when no hospital is in scope. Every authenticated
-- hospital request runs inside forTenant(), so app.tenant_id is set and these
-- tables return zero rows — including to an admin, including to a query with a
-- forgotten WHERE. The platform API sets no tenant, so it can read them.
--
-- Why this matters more than it looks: platform_users holds password hashes
-- for accounts that can open a grant against ANY hospital, and
-- break_glass_grants would tell one hospital that the vendor was in another's
-- data. Neither is something a `where` clause should be the only thing
-- standing in front of.
--
-- break_glass_grants carries a tenantId, so the self-check below already
-- insists it has a policy named tenant_isolation. The name is kept for that
-- reason even though the predicate is inverted — the comment is here so the
-- next reader does not "fix" it into the generic form and quietly make the
-- grant table readable by the hospital it names.
DO $$
DECLARE
  t text;
  platform_tables text[] := ARRAY['platform_users', 'break_glass_grants'];
BEGIN
  FOREACH t IN ARRAY platform_tables LOOP
    IF to_regclass(format('public.%I', t)) IS NULL THEN
      RAISE EXCEPTION
        'Table % is missing. Run `npm run db:migrate` before applying RLS.', t;
    END IF;

    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I '
      'USING (app_current_tenant() IS NULL) '
      'WITH CHECK (app_current_tenant() IS NULL)', t);
  END LOOP;
END $$;

-- Prove it, rather than trusting the predicate reads correctly.
--
-- The first live run of RLS taught this the hard way twice: a psql check that
-- omitted RETURNING passed while Prisma's INSERT ... RETURNING failed, and an
-- isolation proof that never tried logging in shipped a system nobody could
-- sign into. So this asserts the two directions that actually matter.
-- Uses a row it inserts itself, so the check is meaningful on an empty table
-- and does not depend on the seed having run. The whole block is rolled back.
DO $$
DECLARE
  seen_in_tenant  int;
  seen_no_tenant  int;
BEGIN
  PERFORM set_config('app.tenant_id', '', true);

  INSERT INTO platform_users (email, "passwordHash", "fullName", "isActive")
  VALUES ('__rls_probe__@invalid', 'x', 'RLS probe', false);

  SELECT count(*) INTO seen_no_tenant
    FROM platform_users WHERE email = '__rls_probe__@invalid';

  PERFORM set_config('app.tenant_id', '1', true);
  SELECT count(*) INTO seen_in_tenant
    FROM platform_users WHERE email = '__rls_probe__@invalid';

  PERFORM set_config('app.tenant_id', '', true);
  DELETE FROM platform_users WHERE email = '__rls_probe__@invalid';

  -- The direction that protects hospitals: a request running as some hospital
  -- must not see vendor credentials. Runs as the owner, and FORCE subjects the
  -- owner to the policy too, so a non-zero count means the policy is inert.
  IF seen_in_tenant <> 0 THEN
    RAISE EXCEPTION
      'platform_users is readable from inside a tenant scope. Vendor credentials are exposed to hospital requests.';
  END IF;

  -- The mirror case, and the one an isolation-only test would miss. A policy
  -- that denies everyone looks perfect and leaves the platform API unable to
  -- authenticate anybody — exactly the shape of the login chicken-and-egg that
  -- shipped once already.
  IF seen_no_tenant <> 1 THEN
    RAISE EXCEPTION
      'platform_users is not readable outside a tenant scope. The platform API could never sign in.';
  END IF;
END $$;

-- ── 4. self-check ──────────────────────────────────────────────────────────
-- A table with a tenantId column and no policy looks scoped in review and is
-- wide open at runtime. Fail loudly here rather than discovering it later.
DO $$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(c.table_name, ', ') INTO missing
  FROM information_schema.columns c
  JOIN information_schema.tables tb
    ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name
  WHERE c.table_schema = 'public'
    AND c.column_name = 'tenantId'
    AND tb.table_type = 'BASE TABLE'
    AND NOT EXISTS (
      SELECT 1 FROM pg_policies p
      WHERE p.schemaname = 'public'
        AND p.tablename = c.table_name
        AND p.policyname = 'tenant_isolation');

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'Tables have tenantId but no RLS policy: %', missing;
  END IF;
END $$;

-- Also assert nothing was left un-forced, which would let the owner read across
-- tenants without any error to notice.
DO $$
DECLARE
  weak text;
BEGIN
  SELECT string_agg(relname, ', ') INTO weak
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    AND EXISTS (SELECT 1 FROM pg_policies p
                WHERE p.schemaname='public' AND p.tablename=c.relname
                  AND p.policyname='tenant_isolation')
    AND (c.relrowsecurity = false OR c.relforcerowsecurity = false);

  IF weak IS NOT NULL THEN
    RAISE EXCEPTION 'Tables have a policy but RLS is not enabled+forced: %', weak;
  END IF;
END $$;
