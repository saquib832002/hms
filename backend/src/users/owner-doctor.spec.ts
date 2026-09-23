import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * One human, one login — including when that human owns the clinic and treats
 * patients in it.
 *
 * WHY THIS TEST EXISTS
 * --------------------
 * `UserRoleAssignment` was built for exactly this case, and the product still
 * could not do it. A `Doctor` profile could only be created inside
 * `UsersService.create()`, as a side effect of making a *new account*, so an
 * administrator who ticked "Doctor" for themselves was told to create a doctor
 * profile — which meant a second email address and a second password for the
 * same person.
 *
 * That is not a cosmetic annoyance. Two logins for one human breaks the audit
 * trail, and "what did Dr Smith do today" is unanswerable when half their work
 * sits under another account. It is the precise failure the multi-role design
 * exists to prevent, and it survived because nothing asserted the capability
 * end to end — the rule was stated in CLAUDE.md and in three doc comments, and
 * a stated rule with no test is a rule that drifts.
 *
 * Found by an owner who had just been provisioned and could not make himself a
 * doctor.
 */

const SERVICE = readFileSync(resolve(__dirname, './users.service.ts'), 'utf8');
const CONTROLLER = readFileSync(resolve(__dirname, './users.controller.ts'), 'utf8');
const WEB_SHEET = readFileSync(
  resolve(__dirname, '../../../web/components/roles-sheet.tsx'),
  'utf8',
);
const MOBILE_SHEET = readFileSync(
  resolve(__dirname, '../../../mobile/app/(tabs)/settings/staff.tsx'),
  'utf8',
);

/** Comments stripped — the prose explains the bug and would satisfy a match. */
const strip = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

function methodBody(name: string): string {
  const start = SERVICE.indexOf(`async ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const end = SERVICE.indexOf('\n  async ', start + 10);
  return strip(SERVICE.slice(start, end === -1 ? undefined : end));
}

describe('attaching a clinical profile to an existing account', () => {
  it('is possible at all', () => {
    // The capability that was missing. Everything else here is detail.
    expect(SERVICE).toContain('async createDoctorProfile(');
    expect(CONTROLLER).toContain("@Post(':id/doctor-profile')");
  });

  it('is an administrator action, and audited as its own thing', () => {
    // `USER_UPDATE` would bury "somebody became a clinician" inside a generic
    // action, and that is a question a regulator asks by name.
    expect(CONTROLLER).toContain("@AuditAction('DOCTOR_PROFILE_CREATE')");
    expect(CONTROLLER).toContain('@Roles(UserRole.ADMIN)');
  });

  it('creates no account, no password and no email', () => {
    /*
     * The whole point. If this method ever grows a `user.create` or a password
     * hash, it has become "make a second person" again under a friendlier name.
     */
    const body = methodBody('createDoctorProfile');
    for (const forbidden of ['user.create', 'passwordHash', 'generateTemporaryPassword', 'email:']) {
      expect(body).not.toContain(forbidden);
    }
  });

  it('refuses a second profile for the same person', () => {
    const body = methodBody('createDoctorProfile');
    expect(body).toContain('ConflictException');
    // The database is what actually guarantees it, including against two
    // administrators clicking at once.
    const schema = readFileSync(resolve(__dirname, '../../prisma/schema.prisma'), 'utf8');
    expect(schema).toMatch(/userId\s+Int\s+@unique/);
  });

  it('takes the name from the account rather than the form', () => {
    /*
     * Two spellings of one person is how a booking list ends up with "Dr A.
     * Smith" and "Dr Alan Smith" and nobody able to say whether they are the
     * same clinic.
     */
    expect(methodBody('createDoctorProfile')).toContain('fullName: user.fullName');
  });
});

describe('the rule it does not remove', () => {
  it('still refuses the DOCTOR role to somebody with no profile', () => {
    /*
     * This was never wrong. A doctor with no `Doctor` row cannot be booked —
     * appointments key on `Doctor.id` — so granting the role without one
     * produces an account that silently cannot hold a clinic. The fix was to
     * give administrators a way to satisfy the rule, not to drop it.
     */
    const rules = readFileSync(resolve(__dirname, './role-assignment.ts'), 'utf8');
    expect(rules).toContain('hasDoctorProfile');
  });

  it('no longer tells anybody to create a second account', () => {
    // The old message read "Create the doctor profile first", with no way to do
    // that except `POST /users` — which is what sent an owner off to invent a
    // second identity for himself.
    expect(SERVICE).not.toContain('Create the doctor profile first');
    expect(SERVICE).toContain('does not need a second login');
  });
});

describe('both clients offer it where the refusal happens', () => {
  /*
   * On the roles screen, not on a separate one. An administrator meets this
   * problem at the moment they tick "Doctor", and sending them elsewhere to
   * come back afterwards is how a two-step flow gets abandoned halfway.
   */
  it.each([
    ['web', WEB_SHEET],
    ['mobile', MOBILE_SHEET],
  ])('%s asks for a specialization and creates the profile', (_client, src) => {
    const code = strip(src);
    expect(code).toContain('/doctor-profile');
    expect(code).toMatch(/specialization/i);
    // Gated on the person actually lacking one, so it does not nag an
    // administrator who is only reshuffling roles.
    expect(code).toContain("roles.includes('DOCTOR') && user.doctor === null");
  });

  it.each([
    ['web', WEB_SHEET],
    ['mobile', MOBILE_SHEET],
  ])('%s creates the profile before saving the roles', (_client, src) => {
    /*
     * Order matters and is not arbitrary: the server refuses the DOCTOR role
     * for somebody with no profile, so saving roles first would 400 every time.
     */
    const code = strip(src);
    const profile = code.indexOf('/doctor-profile');
    const roles = code.indexOf('/roles`');
    expect(profile).toBeGreaterThan(-1);
    expect(roles).toBeGreaterThan(-1);
    expect(profile).toBeLessThan(roles);
  });
});
