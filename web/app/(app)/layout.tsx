'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { Shell } from '@/components/shell';
import { PasswordGate } from '@/components/password-gate';

/**
 * Client-side guard. It is a UX affordance, not a security boundary — every
 * screen behind it gets its data from an API that enforces access itself.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !user) router.replace('/login');
  }, [user, loading, router]);

  if (loading || !user) {
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
