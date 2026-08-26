import { UserRole } from '@prisma/client';

/**
 * The rules that stop an administrator locking everyone out.
 *
 * These are unglamorous and they are the difference between a bad afternoon
 * and a database console. The realistic failure is not malice: it is an admin
 * tidying up accounts, deactivating their own by mistake, and discovering
 * there is now no way back into the system that manages users.
 *
 * Pure functions on purpose — every one of these is a branch that is awkward to
 * reach through the API and trivial to assert here.
 */

export interface AccountChange {
  /** The admin performing the change. */
  actorId: number;
  /** The account being changed. */
  targetId: number;
  targetRole: UserRole;
  targetIsActive: boolean;
  /** How many *other* active admins exist, excluding the target. */
  otherActiveAdmins: number;
  /** Requested changes. Undefined means "leave alone". */
  newRole?: UserRole;
  newIsActive?: boolean;
}

export interface RuleViolation {
  code: 'SELF_ROLE' | 'SELF_DEACTIVATE' | 'LAST_ADMIN' | 'NO_CHANGE';
  message: string;
}

/**
 * Returns the reason a change must be refused, or null when it is allowed.
 *
 * Returning the reason rather than a boolean matters: "you cannot do that" with
 * no explanation is how someone ends up editing the database directly, which is
 * strictly worse than whatever they were trying to do in the UI.
 */
export function checkAccountChange(change: AccountChange): RuleViolation | null {
  const changingRole = change.newRole !== undefined && change.newRole !== change.targetRole;
  const changingActive =
    change.newIsActive !== undefined && change.newIsActive !== change.targetIsActive;

  if (!changingRole && !changingActive) {
    return { code: 'NO_CHANGE', message: 'Nothing would change' };
  }

  const isSelf = change.actorId === change.targetId;

  // An admin demoting themselves is the fastest way to lose access to user
  // management. If the intent is genuine, another admin can do it — and that
  // second pair of eyes is the point.
  if (isSelf && changingRole) {
    return {
      code: 'SELF_ROLE',
      message: 'You cannot change your own role. Ask another administrator.',
    };
  }

  if (isSelf && changingActive && change.newIsActive === false) {
    return {
      code: 'SELF_DEACTIVATE',
      message: 'You cannot deactivate your own account.',
    };
  }

  // The target is currently an active admin, and after this change would not
  // be — either demoted or switched off. If nobody else holds the role, the
  // system becomes unadministrable.
  const targetIsActiveAdmin = change.targetRole === UserRole.ADMIN && change.targetIsActive;
  const wouldStopBeingAdmin =
    (changingRole && change.newRole !== UserRole.ADMIN) ||
    (changingActive && change.newIsActive === false);

  if (targetIsActiveAdmin && wouldStopBeingAdmin && change.otherActiveAdmins === 0) {
    return {
      code: 'LAST_ADMIN',
      message:
        'This is the only active administrator. Create or activate another before changing this account.',
    };
  }

  return null;
}

/**
 * A temporary password an admin can read aloud.
 *
 * Deliberately not "secure enough to keep" — it exists for one login, after
 * which `mustChangePassword` forces a replacement. Optimising it for entropy
 * while it is being read over a desk misunderstands the threat; optimising it
 * for being *typed correctly once* is the actual job.
 *
 * Characters that get misread aloud or on screen are excluded: no O/0, I/l/1,
 * or similar. A password that has to be repeated three times gets written on a
 * sticky note.
 */
const SAFE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';

export function generateTemporaryPassword(randomBytes: (n: number) => Uint8Array): string {
  const length = 12;
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += SAFE_CHARS[bytes[i] % SAFE_CHARS.length];
  }
  // Grouped for reading aloud: "aB3d-Ef7h-Jk9m".
  return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 12)}`;
}

/** Minimum a replacement password must satisfy. */
export function checkPasswordStrength(password: string): string | null {
  if (password.length < 12) return 'Use at least 12 characters';
  if (!/[a-z]/.test(password)) return 'Include a lowercase letter';
  if (!/[A-Z]/.test(password)) return 'Include an uppercase letter';
  if (!/\d/.test(password)) return 'Include a number';
  // No composition rule beyond this. Length does far more work than symbol
  // requirements, which mostly produce "Password1!" and a sticky note.
  return null;
}
