import { UserRole } from '@prisma/client';

/**
 * The authenticated caller, resolved fresh from the database on every request
 * by JwtStrategy. Deliberately not trusted from the token alone — role and
 * active status can change mid-session and a revoked user must stop working
 * immediately, not in 15 minutes when their access token expires.
 */
export interface AuthUser {
  userId: number;
  /**
   * Which hospital this user belongs to.
   *
   * Read from the user's own row, never from a header, subdomain, or token
   * claim taken at face value — anything client-supplied here is a one-line
   * cross-hospital breach. The per-request re-read below is what makes it
   * authoritative. See docs/adr-001-multi-tenancy.md.
   */
  tenantId: number;
  email: string;

  /**
   * The hospital's own name and display settings.
   *
   * Carried on the authenticated user because every role needs them —
   * billing formats money, reception reads times — and only ADMIN may call
   * /admin/clinic-settings. Re-read per request like everything else here, so
   * an admin changing the currency takes effect on the next request rather
   * than at the next login.
   */
  hospital: {
    name: string;
    slug: string;
    timezone: string;
    /** ISO 4217. Display only — no conversion happens anywhere. */
    currency: string;
  };
  fullName: string;

  /**
   * The role this session is acting as — exactly one.
   *
   * `RolesGuard` compares against this and nothing else, so every existing
   * route rule keeps its meaning. A person who is both owner and doctor is
   * never both at once: they choose, and the choice is recorded on every
   * audited action.
   */
  role: UserRole;

  /**
   * Every role this person could switch to, including the active one.
   *
   * Sent so the client can render a switcher. It grants nothing by itself —
   * switching goes through POST /auth/switch-role, which re-checks the
   * assignment server-side.
   */
  availableRoles: UserRole[];
  /** Present only for DOCTOR. Saves a lookup on every clinical query. */
  doctorId?: number;
  /** Re-read on every request, so a page reload cannot skip the change screen. */
  mustChangePassword: boolean;
}
