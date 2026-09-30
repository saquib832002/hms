'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { Button, Input, Field } from '@/components/ui/primitives';
import { Wordmark } from '@/components/ui/wordmark';

/**
 * Both halves of self-service reset, on one route.
 *
 * WHY ONE PAGE AND NOT TWO
 * ------------------------
 * `?token=` decides which half renders. The alternative is `/forgot-password`
 * and `/reset-password` as siblings, and the reason against it is the link in
 * the email: it has to point somewhere, that somewhere has to be stable
 * forever, and a person who follows an expired one needs to land where they can
 * ask for another. Splitting them means the expired-link page has to link to
 * the request page, which is the same page with one fewer parameter.
 *
 * WHY IT IS NOT UNDER `(app)`
 * ---------------------------
 * Nobody here is signed in, so the app shell — which resolves a role, builds a
 * menu and bounces anybody it cannot place — is exactly wrong. Same reasoning
 * that puts `/login` and `/signup` outside it.
 *
 * WHAT THIS SCREEN WILL NOT TELL YOU
 * ----------------------------------
 * Whether the address has an account. The API answers identically either way
 * and so does this: one sentence, shown after any submission. Anything more
 * helpful would turn a public form into a way to ask whether a named person
 * works at a hospital.
 */
export default function ResetPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ResetPassword />
    </Suspense>
  );
}

function ResetPassword() {
  const token = useSearchParams().get('token');
  return (
    <div className="flex min-h-screen items-center justify-center bg-bg px-4">
      <div className="w-full max-w-[380px]">
        <div className="mb-5 text-center">
          <Wordmark className="text-xl font-bold tracking-tight" />
        </div>
        {token ? <ChooseNew token={token} /> : <AskForLink />}
        <p className="mt-6 text-center text-sm text-text-muted">
          <Link href="/login" className="underline">
            Back to sign in
          </Link>
        </p>
      </div>
    </div>
  );
}

/** Step one: ask for the email. */
function AskForLink() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * The server's own sentence, held rather than copied.
   *
   * It has to read identically for an address with an account and one without —
   * that is the entire enumeration defence — and a second copy of it here is
   * the one that would drift the day somebody reworded the other.
   */
  const [message, setMessage] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ message: string }>('/auth/forgot-password', {
        method: 'POST',
        body: { email: email.trim() },
        // Nobody is signed in. Without this the client tries to refresh a
        // session that does not exist, turning a clean response into a
        // "your session has ended" for somebody who never had one.
        skipRefresh: true,
      });
      setSent(true);
      // The server's own sentence, not a local copy. It is the one part of this
      // flow that has to stay identical for an address with an account and one
      // without, and two copies of a sentence like that is how the two drift.
      setMessage(res.message);
    } catch (err) {
      // A 429 is the realistic failure here and it says so usefully. Anything
      // else is a network problem, which is worth naming rather than showing
      // the success sentence over.
      setError(
        err instanceof ApiError ? err.message : 'Could not send that just now. Try again shortly.',
      );
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <div className="rounded border border-border bg-surface p-5">
        <h1 className="text-base font-semibold text-text">Check your email</h1>
        <p className="mt-2 text-sm text-text-muted">{message}</p>
        <p className="mt-3 text-sm text-text-muted">
          {/*
            Said plainly, because the commonest reason somebody stares at an
            empty inbox is that they have an account at a different hospital, or
            under a different address, and nothing tells them so. The message
            itself cannot say which — that is what it exists not to reveal — but
            the *form* can say what to check, which costs nothing.
          */}
          If nothing arrives, check the address is the one your hospital has for you, and look in
          your spam folder. An administrator at your hospital can also reset it for you from Admin →
          Users.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="rounded border border-border bg-surface p-5">
      <h1 className="text-base font-semibold text-text">Forgot your password?</h1>
      <p className="mb-3 mt-1 text-sm text-text-muted">
        Enter the address you sign in with and we will send a link to set a new one.
      </p>

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

      {/*
        No hospital code here, unlike the sign-in form, and the difference is
        deliberate. Login needs one because it has to pick which account to
        check a password against. This picks nothing: one message goes to the
        mailbox with a link for each hospital the address is registered at.
        Asking for the code would demand the one thing somebody locked out is
        least likely to have — and this is, as it happens, the only place in the
        product where that ambiguity can be resolved without already knowing it.
      */}

      {error && (
        <div
          role="alert"
          className="mb-3 rounded-sm border border-[#f2c4be] bg-danger-soft px-2.5 py-2 text-sm text-[#8a2a1f]"
        >
          {error}
        </div>
      )}

      <Button type="submit" variant="primary" className="w-full" disabled={busy || !email.trim()}>
        {busy ? 'Sending…' : 'Send the link'}
      </Button>
    </form>
  );
}

/** Step two: they followed the link. */
function ChooseNew({ token }: { token: string }) {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  /*
   * Checked here as well as on the server, and this one is not redundant: the
   * server has no second field to compare against, so a mistyped password would
   * be accepted, the token spent, and the person locked out with a password
   * they do not know. The only recovery from that is another link.
   */
  const mismatch = confirm.length > 0 && password !== confirm;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/auth/reset-password', {
        method: 'POST',
        body: { token, newPassword: password },
        skipRefresh: true,
      });
      setDone(true);
    } catch (err) {
      // The server names which rule failed — too short, no digit, link expired.
      // Showing a generic message instead would leave somebody guessing at a
      // rule the response already stated.
      setError(err instanceof ApiError ? err.message : 'Could not set that password');
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="rounded border border-border bg-surface p-5">
        <h1 className="text-base font-semibold text-text">Password changed</h1>
        <p className="mt-2 text-sm text-text-muted">
          Every session you had open has been signed out. Sign in with the new password.
        </p>
        <Button
          variant="primary"
          className="mt-3 w-full"
          onClick={() => router.replace('/login')}
        >
          Sign in
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="rounded border border-border bg-surface p-5">
      <h1 className="text-base font-semibold text-text">Choose a new password</h1>
      <p className="mb-3 mt-1 text-sm text-text-muted">
        At least 12 characters, with an upper-case letter, a lower-case letter and a digit.
      </p>

      <Field label="New password" required>
        <Input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          required
          autoFocus
        />
      </Field>
      <Field label="Type it again" required>
        <Input
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password"
          required
        />
      </Field>

      {mismatch && <p className="mb-3 text-sm text-danger">Those do not match.</p>}

      {error && (
        <div
          role="alert"
          className="mb-3 rounded-sm border border-[#f2c4be] bg-danger-soft px-2.5 py-2 text-sm text-[#8a2a1f]"
        >
          {error}
          {/*
            An expired or spent link is the commonest failure on this screen and
            it is recoverable in one click. Leaving somebody at a dead end with
            a red box is how a recovery flow earns a reputation for not working.
          */}
          <Link href="/reset-password" className="ml-1 underline">
            Ask for a new link
          </Link>
        </div>
      )}

      <Button
        type="submit"
        variant="primary"
        className="w-full"
        disabled={busy || password.length < 12 || mismatch || !confirm}
      >
        {busy ? 'Saving…' : 'Set password'}
      </Button>
    </form>
  );
}
