'use client';

import { useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { Button, Field, Input } from '@/components/ui/primitives';

/**
 * Blocks the application until a forced password change is done.
 *
 * Rendered *above* the shell rather than as a route, so there is no URL that
 * skips it. A user whose password was set by an administrator is holding a
 * credential two people know, and that credential reads patient records — the
 * gate is the point at which it stops being shared.
 *
 * `mustChangePassword` is re-read from the server on every request (it lives on
 * `AuthUser`, which `JwtStrategy` rebuilds per call), so a page reload cannot
 * get past it either.
 */
export function PasswordGate({ children }: { children: React.ReactNode }) {
  const { user, signOut } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (!user?.mustChangePassword) return <>{children}</>;

  const mismatch = confirm.length > 0 && next !== confirm;
  const valid = current.length > 0 && next.length >= 12 && next === confirm;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api('/me/password', {
        method: 'POST',
        body: { currentPassword: current, newPassword: next },
      });
      // The server revokes every session on a successful change, including this
      // one. Signing out and back in is the honest consequence rather than
      // pretending the current tokens still work.
      await signOut();
    } catch (err) {
      // The server returns the specific weakness ("Include a number"), which is
      // far more useful than a generic rule list.
      setError(err instanceof ApiError ? err.message : 'Could not change your password');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg px-4">
      <div className="w-full max-w-[400px]">
        <div className="mb-5 text-center">
          <div className="text-xl font-bold tracking-tight">
            Meridian<span className="text-primary">HMS</span>
          </div>
          <p className="mt-1 text-sm text-text-muted">Set your own password to continue</p>
        </div>

        <form onSubmit={submit} className="rounded border border-border bg-surface p-5">
          <div className="mb-4 rounded-sm border border-[#ecdca6] bg-warning-soft px-3 py-2 text-sm text-[#6b5314]">
            Your password was set by an administrator, so more than one person knows it. Choose your
            own before continuing.
          </div>

          <Field label="Current password" required hint="The temporary one you were given.">
            <Input
              type="password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              autoComplete="current-password"
              autoFocus
            />
          </Field>

          <Field
            label="New password"
            required
            hint="At least 12 characters, with an uppercase letter and a number. A short phrase works well."
          >
            <Input
              type="password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              autoComplete="new-password"
            />
          </Field>

          <Field label="Confirm new password" required error={mismatch ? 'These do not match' : undefined}>
            <Input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
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

          <Button type="submit" variant="primary" className="w-full" disabled={!valid || submitting}>
            {submitting ? 'Saving…' : 'Set password and sign in again'}
          </Button>

          <p className="mt-2.5 text-center text-xs text-text-subtle">
            You will be signed out of every device and can sign back in with the new password.
          </p>
        </form>

        <button
          onClick={() => void signOut()}
          className="mx-auto mt-4 block text-xs text-text-muted underline-offset-2 hover:underline"
        >
          Sign out instead
        </button>
      </div>
    </div>
  );
}
