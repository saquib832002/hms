'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { landingFor } from '@/lib/nav';

/**
 * Role-based redirect. Each role lands on the screen it spends the day on,
 * not a shared dashboard nobody uses.
 */
export default function Home() {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    router.replace(user ? landingFor(user.role) : '/login');
  }, [user, loading, router]);

  return (
    <div className="flex h-screen items-center justify-center text-sm text-text-subtle">
      Loading…
    </div>
  );
}
