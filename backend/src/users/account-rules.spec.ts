import { UserRole } from '@prisma/client';
import {
  checkAccountChange,
  checkPasswordStrength,
  generateTemporaryPassword,
} from './account-rules';

const base = {
  actorId: 1,
  targetId: 2,
  targetRole: UserRole.NURSE,
  targetIsActive: true,
  otherActiveAdmins: 2,
};

describe('checkAccountChange', () => {
  it('allows a straightforward role change', () => {
    expect(checkAccountChange({ ...base, newRole: UserRole.DOCTOR })).toBeNull();
  });

  it('allows deactivating someone else', () => {
    expect(checkAccountChange({ ...base, newIsActive: false })).toBeNull();
  });

  it('refuses a no-op rather than pretending to save', () => {
    expect(checkAccountChange({ ...base, newRole: UserRole.NURSE })?.code).toBe('NO_CHANGE');
    expect(checkAccountChange({ ...base, newIsActive: true })?.code).toBe('NO_CHANGE');
    expect(checkAccountChange({ ...base })?.code).toBe('NO_CHANGE');
  });

  describe('protecting the actor from themselves', () => {
    const self = { ...base, actorId: 5, targetId: 5, targetRole: UserRole.ADMIN };

    it('refuses changing your own role', () => {
      // The fastest route to losing access to user management.
      const result = checkAccountChange({ ...self, newRole: UserRole.NURSE });
      expect(result?.code).toBe('SELF_ROLE');
      expect(result?.message).toMatch(/another administrator/i);
    });

    it('refuses deactivating your own account', () => {
      expect(checkAccountChange({ ...self, newIsActive: false })?.code).toBe('SELF_DEACTIVATE');
    });

    it('still allows reactivating yourself', () => {
      // Not a lockout risk, and harmless — you are already signed in.
      expect(
        checkAccountChange({ ...self, targetIsActive: false, newIsActive: true }),
      ).toBeNull();
    });
  });

  describe('protecting the last administrator', () => {
    const lastAdmin = {
      ...base,
      actorId: 1,
      targetId: 9,
      targetRole: UserRole.ADMIN,
      targetIsActive: true,
      otherActiveAdmins: 0,
    };

    it('refuses demoting the only active admin', () => {
      const result = checkAccountChange({ ...lastAdmin, newRole: UserRole.NURSE });
      expect(result?.code).toBe('LAST_ADMIN');
      expect(result?.message).toMatch(/only active administrator/i);
    });

    it('refuses deactivating the only active admin', () => {
      expect(checkAccountChange({ ...lastAdmin, newIsActive: false })?.code).toBe('LAST_ADMIN');
    });

    it('allows it once another admin exists', () => {
      expect(
        checkAccountChange({ ...lastAdmin, otherActiveAdmins: 1, newRole: UserRole.NURSE }),
      ).toBeNull();
    });

    it('does not block promoting someone else to admin', () => {
      // The way *out* of the last-admin situation must never be blocked.
      expect(
        checkAccountChange({
          ...base,
          targetRole: UserRole.NURSE,
          otherActiveAdmins: 0,
          newRole: UserRole.ADMIN,
        }),
      ).toBeNull();
    });

    it('does not block deactivating a non-admin when there are no other admins', () => {
      expect(
        checkAccountChange({ ...base, targetRole: UserRole.NURSE, otherActiveAdmins: 0, newIsActive: false }),
      ).toBeNull();
    });

    it('does not block changes to an already-inactive admin', () => {
      // They are not holding the system up, so nothing is lost.
      expect(
        checkAccountChange({
          ...lastAdmin,
          targetIsActive: false,
          newRole: UserRole.NURSE,
        }),
      ).toBeNull();
    });
  });

  it('reports self-protection before the last-admin rule', () => {
    // Both apply when the sole admin edits themselves. "Ask another
    // administrator" is the more actionable message of the two.
    const result = checkAccountChange({
      actorId: 7,
      targetId: 7,
      targetRole: UserRole.ADMIN,
      targetIsActive: true,
      otherActiveAdmins: 0,
      newRole: UserRole.NURSE,
    });
    expect(result?.code).toBe('SELF_ROLE');
  });
});

describe('generateTemporaryPassword', () => {
  // Deterministic bytes so the shape can be asserted.
  const fakeRandom = (n: number) => Uint8Array.from({ length: n }, (_, i) => i * 7);

  it('is grouped for reading aloud', () => {
    const password = generateTemporaryPassword(fakeRandom);
    expect(password).toMatch(/^[A-Za-z2-9]{4}-[A-Za-z2-9]{4}-[A-Za-z2-9]{4}$/);
  });

  it('excludes characters that get misheard or misread', () => {
    // A password that has to be repeated three times ends up on a sticky note.
    for (let seed = 0; seed < 40; seed++) {
      const password = generateTemporaryPassword((n) =>
        Uint8Array.from({ length: n }, (_, i) => (i + seed) * 13),
      );
      expect(password).not.toMatch(/[O0Il1]/);
    }
  });

  it('varies with the random source', () => {
    const a = generateTemporaryPassword((n) => Uint8Array.from({ length: n }, () => 1));
    const b = generateTemporaryPassword((n) => Uint8Array.from({ length: n }, () => 2));
    expect(a).not.toBe(b);
  });
});

describe('checkPasswordStrength', () => {
  it('accepts a reasonable password', () => {
    expect(checkPasswordStrength('CorrectHorse42')).toBeNull();
  });

  it.each([
    ['short1A', /12 characters/],
    ['alllowercase1', /uppercase/],
    ['ALLUPPERCASE1', /lowercase/],
    ['NoDigitsAtAllHere', /number/],
  ])('rejects "%s"', (password, expected) => {
    expect(checkPasswordStrength(password)).toMatch(expected);
  });

  it('does not demand a symbol', () => {
    // Symbol rules mostly produce "Password1!" — length does more work.
    expect(checkPasswordStrength('LongEnoughPass1')).toBeNull();
  });

  it('accepts a long passphrase', () => {
    expect(checkPasswordStrength('Ward3 corridor lamp Post')).toBeNull();
  });
});
