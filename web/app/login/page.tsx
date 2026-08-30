'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { canReach, landingFor } from '@/lib/nav';
import { Button, Input, Field } from '@/components/ui/primitives';
import type { UserRole } from '@/lib/types';

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}

/**
 * `?next=` is set when a session expires mid-work, so signing back in returns
 * the user to the screen they were on.
 *
 * Only same-origin absolute paths are honoured. Reflecting an arbitrary
 * `next` value into a redirect is a textbook open-redirect — and on a system
 * whose login page is worth phishing, that is not a theoretical concern.
 */
function safeNext(next: string | null): string | null {
  if (!next) return null;
  if (!next.startsWith('/')) return null;
  if (next.startsWith('//')) return null; // protocol-relative → another origin
  if (next === '/login') return null;
  return next;
}

/**
 * `next` belongs to whoever was here before, which is not necessarily whoever
 * just signed in.
 *
 * A shared desk machine keeps `?next=/queue` in the address bar after a
 * doctor's session ends; the administrator who signs in next gets sent to the
 * doctor's queue, sees a broken screen, and puts a denied clinical access into
 * the hospital's audit log under their own name. The destination has to be
 * checked against the role that actually arrived, not the one that left.
 */
function nextForRole(next: string | null, role: UserRole): string {
  return next && canReach(role, next) ? next : landingFor(role);
}

function LoginForm() {
  const { user, loading, signIn } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNext(params.get('next'));
  const expired = params.has('next');

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!loading && user) router.replace(nextForRole(next, user.role));
  }, [user, loading, router, next]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const u = await signIn(email, password);
      router.replace(nextForRole(next, u.role));
    } catch (err) {
      // The API returns the same message for unknown email and wrong password
      // on purpose — distinguishing them lets an attacker enumerate staff.
      setError(err instanceof Error ? err.message : 'Could not sign in');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg px-4">
      <div className="w-full max-w-[360px]">
        <div className="mb-5 text-center">
          <div className="text-xl font-bold tracking-tight">
            Meridian<span className="text-primary">HMS</span>
          </div>
          <p className="mt-1 text-sm text-text-muted">Staff sign in</p>
        </div>

        {expired && !error && (
          <div className="mb-3 rounded-sm border border-[#ecdca6] bg-warning-soft px-3 py-2 text-sm text-[#6b5314]">
            Your session ended. Sign in to carry on where you left off.
          </div>
        )}

        <form onSubmit={onSubmit} className="rounded border border-border bg-surface p-5">
          <Field label="Email" required>
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
              required
              autoFocus
            />
          </Field>
          <Field label="Password" required>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </Field>

          {error && (
            <div
              role="alert"
              className="mb-3 rounded-sm border border-[#f2c4be] bg-danger-soft px-2.5 py-2 text-sm text-[#8a2a1f]"
            >
              {error}
            </div>
          )}

          <Button type="submit" variant="primary" className="w-full" disabled={submitting}>
            {submitting ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>

        {process.env.NODE_ENV !== 'production' && (
          <div className="mt-4 rounded border border-dashed border-border-strong bg-surface p-3 text-xs text-text-muted">
            <div className="mb-1 font-semibold text-text">Development accounts</div>
            <div className="font-mono leading-relaxed">
              doctor@demo.test · reception@demo.test
              <br />
              nurse@demo.test · admin@demo.test
              <br />
              password: ChangeMe123!
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
