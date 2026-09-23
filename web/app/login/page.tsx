'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { canReach, landingFor } from '@/lib/nav';
import { Button, Input, Field } from '@/components/ui/primitives';
import type { TenantModule, UserRole } from '@/lib/types';

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
function nextForRole(next: string | null, role: UserRole, modules: TenantModule[]): string {
  // Checked against the modules too. A `?next=/lab/worklist` left in the bar at
  // a hospital that has since had the laboratory removed is the same trap as a
  // `?next=` belonging to another role.
  return next && canReach(role, next, modules) ? next : landingFor(role, modules);
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

  /**
   * The hospital's own code, shown only after something has already failed.
   *
   * WHY THIS FIELD EXISTS
   * ---------------------
   * An email address is unique *per hospital*, so one person can hold accounts
   * at two — and login refuses to guess between them, deliberately, because
   * asking "which hospital did you mean" confirms to anyone who asks that the
   * address is registered and at more than one place. The way out is to say
   * which, and the API has accepted `hospital` since login was written while
   * **neither client could send it**. Anybody in that position got *Invalid
   * email or password* against a perfectly correct password, which is the
   * quietest possible version of a dead end.
   *
   * WHY IT APPEARS ONLY AFTER A FAILURE, AND ONLY AFTER *ANY* FAILURE
   * -----------------------------------------------------------------
   * Almost nobody has two accounts, so a third box on every sign-in is clutter
   * on the most-used screen in the product. Revealing it after a failure keeps
   * the form clean and still puts it in front of the one person who needs it.
   *
   * The important half is that it appears after *every* failure — a wrong
   * password included — and not only after the ambiguous one. Showing it only
   * when the address is genuinely at two hospitals would leak exactly what the
   * single refusal message exists to hide, by the shape of the form rather than
   * by its words. The server never says which case it was; neither does this.
   */
  const [hospital, setHospital] = useState('');
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!loading && user) router.replace(nextForRole(next, user.role, user.hospital.modules));
  }, [user, loading, router, next]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const u = await signIn(email, password, hospital.trim() || undefined);
      router.replace(nextForRole(next, u.role, u.hospital.modules));
    } catch (err) {
      // The API returns the same message for unknown email and wrong password
      // on purpose — distinguishing them lets an attacker enumerate staff.
      setError(err instanceof Error ? err.message : 'Could not sign in');
      // Reveal the hospital code on any failure — see the note on `hospital`.
      setFailed(true);
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

          {/*
            Shown after any failure, never only after the ambiguous one — the
            form's shape must not say what the message deliberately will not.
          */}
          {failed && (
            <Field label="Hospital code" hint="Only if you have accounts at more than one hospital. An administrator there can read it off the clinic settings screen.">
              <Input
                value={hospital}
                onChange={(e) => setHospital(e.target.value)}
                placeholder="e.g. meridian-clinic"
                autoComplete="organization"
              />
            </Field>
          )}

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
