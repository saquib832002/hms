'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
// `Link`, never `<a href>`: the access token is held in memory only, so a raw
// anchor is a full document load that drops it. `client-nav.spec.ts` fails the
// build on one. Harmless on the login screen, where there is no session yet —
// and exactly the sort of local reasoning that put two of them on the pharmacy
// screens, so the rule holds everywhere rather than where it currently bites.
import Link from 'next/link';
import { useAuth } from '@/lib/auth-context';
import { api } from '@/lib/api';
import { canReach, landingFor } from '@/lib/nav';
import { Button, Input, Field } from '@/components/ui/primitives';
import { Wordmark } from '@/components/ui/wordmark';
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

  /**
   * Whether this deployment can actually send a reset link.
   *
   * Asked before the link is offered, rather than assumed. Self-service reset
   * needs a mail transport, and one is not guaranteed — a deployment without
   * `MAIL_TRANSPORT` set has none. Offering "Forgot password?" there leads to a
   * form that says a link is on its way and sends nothing, which is the failure
   * this codebase has recorded over and over, arriving at the one screen where
   * the person reading it is already stuck.
   *
   * Starts `null` — unknown — and the link renders on `true` only, so a health
   * check that has not answered yet shows nothing rather than flashing a
   * promise and withdrawing it.
   */
  const [resetAvailable, setResetAvailable] = useState<boolean | null>(null);
  /** `smtp` | `log` | `none` — so the screen can say what will happen. */
  const [resetDelivery, setResetDelivery] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Through the shared client, not a bare fetch: it carries the `/api/v1`
    // prefix and the credentials mode in one place. `skipRefresh` because
    // nobody is signed in — without it a 401 would send the client chasing a
    // session that does not exist, on the screen whose whole job is not having
    // one yet.
    api<{ passwordResetAvailable?: boolean; passwordResetDelivery?: string }>('/health', {
      skipRefresh: true,
    })
      .then((body) => {
        if (cancelled) return;
        setResetAvailable(body?.passwordResetAvailable === true);
        setResetDelivery(body?.passwordResetDelivery ?? null);
      })
      /*
       * Hide the link, and say why in the console.
       *
       * Not shown to the user — a failed health check on a sign-in screen is
       * noise, and the sign-in attempt itself reports the real problem in a
       * sentence that means something. But it must not be *silent* either: a
       * missing link means "no mail transport configured" or "the capability
       * check did not answer", and those are opposite problems that render
       * identically. The console line is what tells them apart.
       */
      .catch((err) => {
        if (cancelled) return;
        // eslint-disable-next-line no-console
        console.warn('Could not read password-reset capability; hiding the reset link.', err);
        setResetAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
          <Wordmark className="text-xl font-bold tracking-tight" />
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
                placeholder="e.g. st-marys"
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

          {/*
            Inside the form and under the button, which is where people look for
            it. Rendered only when the deployment can actually deliver — see
            `resetAvailable`. Where it cannot, there is deliberately nothing
            here rather than a disabled control explaining itself: the person
            reading this screen cannot configure SMTP, and the two routes that
            do work for them (their administrator, or the vendor) are a
            conversation rather than a link.
          */}
          {resetAvailable === true && (
            <p className="mt-3 text-center text-sm">
              <Link href="/reset-password" className="text-text-muted underline">
                Forgot your password?
              </Link>
              {/*
                Said on the screen rather than left to be discovered. With the
                `log` transport the flow works end to end and no message
                leaves the building — the link is printed in the API log. A
                control that behaves differently here from how it behaves in
                production, with nothing admitting it, is how somebody comes to
                believe mail works on this deployment.
              */}
              {resetDelivery === 'log' && (
                <span className="mt-1 block text-xs text-warning">
                  Development: the link is printed in the API log, not emailed.
                </span>
              )}
            </p>
          )}
        </form>

        {/*
         * The way in for somebody who is not a customer yet.
         *
         * `/signup` has existed since public signup was built and **nothing
         * linked to it** — it was reachable only by typing the URL, which is the
         * eighth instance in this project of a capability with no route in, and
         * the one with the widest consequence: a hospital that wants to buy the
         * product could not ask.
         *
         * It sits below the form rather than beside "Sign in", because every
         * person who loads this screen on any ordinary day already has an
         * account. The label says what happens next — an application a human
         * reads, not an account — since "Register" on a login screen reads as
         * self-service, and signing up here does not create a hospital or let
         * anybody in. See `signup/page.tsx` and `signup.controller.ts`.
         */}
        <p className="mt-6 text-center text-sm text-text-muted">
          New hospital?{' '}
          <Link href="/signup" className="font-medium text-text underline">
            Apply for an account
          </Link>
        </p>

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
