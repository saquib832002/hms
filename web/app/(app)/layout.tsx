'use client';

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { canReach, landingFor } from '@/lib/nav';
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
  const { user, loading } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const allowed = !user || !pathname || canReach(user.role, pathname);

  useEffect(() => {
    if (loading) return;
    if (!user) router.replace('/login');
    else if (!allowed) router.replace(landingFor(user.role));
  }, [user, loading, allowed, router]);

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
