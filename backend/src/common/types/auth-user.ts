import { SubscriptionStatus, TenantModule, UserRole } from '@prisma/client';

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

    /**
     * The hospital's standing with the vendor.
     *
     * Here so `SubscriptionGuard` can answer "may this request write?" without
     * a second query, and so a client can warn before anything stops working.
     * A lapsed subscription blocks writes and never blocks a read or a login —
     * see `common/subscription/subscription.ts` for why that line is where it
     * is.
     */
    subscriptionStatus: SubscriptionStatus;
    subscriptionEndsAt: Date | null;

    /**
     * What this hospital has been sold. See `TenantModule`.
     *
     * Here for the same reason the subscription is: `ModuleGuard` needs it on
     * every write, and re-reading the tenant per request would be a second
     * query for a row this one already has. Sent to the clients too, because
     * the menus are built from it — a lab-only tenant should not be looking at
     * a ward board it can never use.
     *
     * A usability boundary on the client, a real one here. The guard assumes
     * any client can call any endpoint, exactly as `RolesGuard` does.
     */
    modules: TenantModule[];
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
