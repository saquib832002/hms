import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BadRequestException } from '@nestjs/common';
import { planProvision, slugify, uniqueSlug } from './provisioning';

const SERVICE = readFileSync(resolve(__dirname, './platform.service.ts'), 'utf8');

/** The body of `provision`, comments stripped so prose cannot satisfy a match. */
function provisionBody(): string {
  const start = SERVICE.indexOf('  async provision(');
  expect(start).toBeGreaterThan(-1);
  return SERVICE.slice(start, SERVICE.indexOf('\n  async ', start + 10))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

describe('creating a hospital', () => {
  const body = provisionBody();

  it('enters the new tenant’s scope before writing its first user', () => {
    /*
     * THE BUG THIS PINS, FOUND ON THE FIRST LIVE RUN OF THE PLATFORM API
     * -------------------------------------------------------------------
     * `unscoped` connects as `hms_app`, a non-superuser, so RLS applies. The
     * `tenants` insert succeeded because `tenants` is a global model with no
     * policy. The `users` insert did not: its WITH CHECK is
     * `tenantId = app_current_tenant()`, and with no tenant on the transaction
     * that function returns NULL.
     *
     * Provisioning therefore died between creating the hospital and creating
     * the only account able to sign into it — the exact half-finished state the
     * single transaction exists to prevent, arriving by a route the transaction
     * could not help with.
     *
     * No unit test could have caught it. `tenant-coverage.spec.ts` checks that
     * models carry policies; nothing checks that a caller establishes scope, and
     * every test in this suite runs without a database. CLAUDE.md predicted it
     * in as many words — "the platform API has never run … assume this has one".
     */
    const setScope = body.indexOf("set_config('app.tenant_id'");
    const createUser = body.indexOf('tx.user.create(');

    expect(setScope).toBeGreaterThan(-1);
    expect(createUser).toBeGreaterThan(-1);
    expect(setScope).toBeLessThan(createUser);
  });

  it('sets it transaction-locally, not on the connection', () => {
    /*
     * The third argument to `set_config` is `is_local`. False would persist the
     * value for the life of a *pooled* connection, so the next request — a
     * different hospital — inherits it. That is verified past behaviour, not
     * caution: rows stayed visible on the connection long after the request
     * that set them had finished.
     */
    expect(body).toMatch(/set_config\('app\.tenant_id',\s*\$\{[^}]+\},\s*true\)/);
  });

  it('creates the hospital and its administrator in one transaction', () => {
    // A tenant with no admin is a hospital nobody can sign into that is also
    // holding the slug, so the retry collides with the wreckage of the first
    // attempt.
    expect(body).toContain('$transaction(');
    const tx = body.indexOf('$transaction(');
    expect(body.indexOf('tx.tenant.create(')).toBeGreaterThan(tx);
    expect(body.indexOf('tx.user.create(')).toBeGreaterThan(tx);
  });

  it('returns the temporary password exactly once, and never stores it', () => {
    // It is hashed on the way in, so this response is the only chance to read
    // it. `mustChangePassword` is what makes handing it over acceptable.
    expect(body).toContain('temporaryPassword');
    expect(body).toContain('mustChangePassword: true');
    expect(body).toContain('passwordHash');
  });
});

describe('slugs', () => {
  it('derives a URL-safe name', () => {
    expect(slugify("St Mary's Clinic")).toBe('st-mary-s-clinic');
    expect(slugify('  Hôpital Général  ')).toBe('hopital-general');
    expect(slugify('A/B & C')).toBe('a-b-c');
  });

  it('never ends in a hyphen, even after truncation', () => {
    // A trailing hyphen is a URL nobody types correctly and a slug that looks
    // like a bug in whatever printed it.
    expect(slugify('x'.repeat(59) + ' y')).not.toMatch(/-$/);
  });

  it('appends a readable suffix rather than a random one', () => {
    /*
     * `st-marys-2` over `st-marys-7f3a`. This string is what a receptionist
     * types to sign in and reads out over a phone; unguessability buys nothing
     * here and costs every future support call.
     */
    expect(uniqueSlug("St Mary's", new Set(['st-mary-s']))).toBe('st-mary-s-2');
    expect(uniqueSlug("St Mary's", new Set(['st-mary-s', 'st-mary-s-2']))).toBe('st-mary-s-3');
  });

  it('falls back rather than producing an empty slug', () => {
    expect(uniqueSlug('!!!', new Set())).toBe('hospital');
  });
});

describe('validating a provisioning request', () => {
  const base = { hospitalName: 'St Mary’s', adminEmail: 'jane@example.com', adminName: 'Jane O' };

  it('refuses a requested slug that is taken, rather than silently suffixing it', () => {
    /*
     * Somebody asked for a specific address. Handing them `st-marys-2` without
     * saying so is the kind of quiet substitution nobody notices until a
     * printed sign-in card is wrong.
     */
    expect(() => planProvision({ ...base, slug: 'taken' }, new Set(['taken']))).toThrow(
      BadRequestException,
    );
  });

  it('suffixes freely when no slug was requested', () => {
    // Nobody has an expectation to violate here.
    const plan = planProvision(base, new Set(['st-mary-s']));
    expect(plan.slug).toBe('st-mary-s-2');
  });

  it('rejects a timezone Intl does not recognise', () => {
    /*
     * A hospital on the wrong zone gets a clinic day that ends before its staff
     * arrive and a booking page offering only past slots — which presents as a
     * bug in booking rather than a wrong setting. Catching it at provisioning
     * is far cheaper than diagnosing it later.
     */
    expect(() => planProvision({ ...base, timezone: 'IST' }, new Set())).toThrow(
      BadRequestException,
    );
    expect(planProvision({ ...base, timezone: 'Asia/Kolkata' }, new Set()).timezone).toBe(
      'Asia/Kolkata',
    );
  });

  it('normalises the currency and the email', () => {
    const plan = planProvision(
      { ...base, currency: 'inr', adminEmail: '  Jane@Example.COM ' },
      new Set(),
    );
    expect(plan.currency).toBe('INR');
    expect(plan.adminEmail).toBe('jane@example.com');
  });

  it('refuses incomplete input before any row is written', () => {
    // All of it up front, because provisioning creates a tenant *and* a user:
    // the transaction protects against a crash, this protects against input the
    // transaction would have committed happily.
    expect(() => planProvision({ ...base, adminEmail: 'not-an-email' }, new Set())).toThrow();
    expect(() => planProvision({ ...base, hospitalName: 'x' }, new Set())).toThrow();
    expect(() => planProvision({ ...base, adminName: '' }, new Set())).toThrow();
  });
});
