'use client';

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import {
  actableRoles,
  canReach,
  hasAnyScreen,
  landingFor,
  roleRequiresModule,
  ROLE_LABEL,
} from '@/lib/nav';
import { Shell } from '@/components/shell';
import { PasswordGate } from '@/components/password-gate';

/**
 * Client-side guard. It is a UX affordance, not a security boundary — every
 * screen behind it gets its data from an API that enforces access itself.
 *
 * WHY IT ALSO CHECKS THE ROUTE, NOT ONLY THE SESSION
 * --------------------------------------------------
 * Hiding a link from the sidebar does not stop the URL from being reached —
 * by typing it, by a stale bookmark, or by signing in as one role with a
 * `?next=` left over from another. An admin who lands on `/queue` gets a
 * broken screen and, worse, writes a denied clinical access into the
 * hospital's own audit log. Nothing leaked; the API refused. But the trail now
 * contains a security event the app manufactured, and denials are the rows a
 * reviewer is supposed to be able to trust.
 *
 * Unknown paths pass through so a typo still reaches a 404 rather than being
 * quietly redirected as if it were forbidden.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { user, loading, switchRole } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  // Narrowed by the hospital's modules as well as the role — a bookmarked
  // screen for a module they were never sold is as unreachable as one
  // belonging to another role.
  const allowed =
    !user || !pathname || canReach(user.role, pathname, user.hospital.modules);

  /*
   * A role can be left with no screen at all — see `hasAnyScreen`. Redirecting
   * in that state is what produced an endless spinner, so the redirect is
   * skipped and the message below is rendered instead.
   */
  const stranded = Boolean(user) && !hasAnyScreen(user!.role, user!.hospital.modules);

  useEffect(() => {
    if (loading) return;
    if (!user) router.replace('/login');
    else if (!allowed && !stranded) {
      router.replace(landingFor(user.role, user.hospital.modules));
    }
  }, [user, loading, allowed, stranded, router]);

  if (user && stranded) {
    const missing = roleRequiresModule(user.role);
    // Other roles this person holds that this hospital can actually use.
    const escapes = actableRoles(user.availableRoles, user.hospital.modules).filter(
      (role) => role !== user.role,
    );
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-2 px-6 text-center">
        <h1 className="text-lg font-semibold text-text">Nothing here for you yet</h1>
        <p className="max-w-md text-sm text-text-muted">
          {missing
            ? `${ROLE_LABEL[user.role]} works on the ${missing.toLowerCase()} module, which is not part of ${user.hospital.name}’s plan. Nothing has been deleted — it all comes back if your provider adds it.`
            : `No screens are available for your role at ${user.hospital.name}.`}
        </p>
        {/*
          The way out, and without it this screen is a dead end.

          The switcher lives in the shell, which is not rendered here — so an
          owner-doctor whose default role is the unsold one could read this
          message and have no way to reach the ADMIN role they also hold. The
          same failure shape as every other refusal in this project that
          named a precondition nobody could satisfy.
        */}
        {escapes.length > 0 ? (
          <div className="mt-1 flex flex-wrap justify-center gap-1.5">
            {escapes.map((role) => (
              <button
                key={role}
                type="button"
                onClick={() => void switchRole(role)}
                className="rounded-sm border border-border-strong bg-surface px-2.5 py-1 text-xs hover:border-primary"
              >
                Continue as {ROLE_LABEL[role]}
              </button>
            ))}
          </div>
        ) : (
          <p className="text-sm text-text-subtle">
            Ask an administrator here to give you a role your hospital does use.
          </p>
        )}
      </div>
    );
  }

  if (loading || !user || !allowed) {
    return (
      <div className="flex h-screen items-center justify-center text-sm text-text-subtle">
        Loading…
      </div>
    );
  }

  // PasswordGate sits above the shell, not inside a route — there is no URL
  // that skips a forced password change.
  return (
    <PasswordGate>
      <Shell>{children}</Shell>
    </PasswordGate>
  );
}
