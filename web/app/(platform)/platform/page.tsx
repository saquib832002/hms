'use client';

import { useCallback, useEffect, useState } from 'react';
import { platformApi, PlatformApiError, setPlatformToken } from '@/lib/platform-api';
import { ALL_MODULES, MODULE_DESCRIPTION, MODULE_LABEL } from '@/lib/nav';
import type { TenantModule } from '@/lib/types';

/**
 * The vendor console.
 *
 * WHAT THIS IS AND IS NOT
 * -----------------------
 * It is the vendor's own screen for onboarding and subscriptions. It is *not*
 * an admin view of hospitals: there is no patient here, no clinical data, and
 * no route that could return any. Reading inside a hospital needs a break-glass
 * grant, and even that buys aggregates and configuration only.
 *
 * WHY IT LIVES IN THIS APP
 * ------------------------
 * Chosen for one deployment rather than two. The separation that matters is
 * unchanged and is on the server: `PlatformUser` has its own login and token
 * audience, and `PlatformGuard` sets no `req.user`, so a hospital session
 * cannot reach a single route on this page — and `RolesGuard` admits nobody
 * without a `UserRole`, which a vendor token does not carry.
 *
 * What was given up is defence in depth: platform code now ships in the same
 * build a receptionist loads. `endpoint-coverage.spec.ts` replaces the old
 * blanket ban with a directory boundary — only this route group and
 * `lib/platform-api.ts` may name the vendor API, and this group may call
 * nothing else.
 *
 * ONE FILE, ON PURPOSE
 * --------------------
 * Three lists and two forms, used by a handful of people who will learn it in a
 * day. Splitting it across a shell, a sidebar and five routes would mirror the
 * hospital app's structure without the reason for it — staff live in that app
 * for eight hours; nobody lives here.
 */

type Tab = 'applications' | 'tenants';

interface Application {
  id: number;
  hospitalName: string;
  requestedSlug: string | null;
  /**
   * Which modules they asked for, empty when they skipped the question.
   *
   * Optional on the type as well as possibly empty, because a console build can
   * outlive an API that predates the column — and `defaultModules` reads both
   * the same way rather than crashing on `undefined.length`.
   */
  requestedModules?: TenantModule[];
  contactName: string;
  contactEmail: string;
  contactPhone: string | null;
  timezone: string | null;
  currency: string | null;
  notes: string | null;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  tenantId: number | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  createdAt: string;
  submittedFromIp: string | null;
  duplicateOfEmail: boolean;
}

interface Tenant {
  id: number;
  slug: string;
  name: string;
  isActive: boolean;
  timezone: string;
  currency: string;
  users: number;
  patients: number;
  subscriptionStatus: 'TRIAL' | 'ACTIVE' | 'PAST_DUE' | 'SUSPENDED' | 'CANCELLED';
  subscriptionEndsAt: string | null;
  subscriptionNote: string | null;
  /** What this hospital was sold. Separate from whether they have paid for it. */
  modules: TenantModule[];
  canWrite: boolean;
  daysRemaining: number | null;
}

/** What `PATCH /platform/tenants/:id/modules` answers with. */
interface ModulesChanged {
  id: number;
  name: string;
  modules: TenantModule[];
  removed: TenantModule[];
  strandedRecords: { module: TenantModule; records: number }[];
}

interface Provisioned {
  tenant: { id: number; slug: string; name: string };
  administrator: { email: string; fullName: string; temporaryPassword: string };
}

const STATUSES = ['TRIAL', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELLED'] as const;

export default function PlatformConsole() {
  const [signedIn, setSignedIn] = useState(false);
  const [tab, setTab] = useState<Tab>('applications');
  const [applications, setApplications] = useState<Application[] | null>(null);
  const [tenants, setTenants] = useState<Tenant[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [credentials, setCredentials] = useState<Provisioned | null>(null);
  const [creating, setCreating] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [apps, tens] = await Promise.all([
        platformApi<{ data: Application[] }>('/platform/applications'),
        platformApi<{ data: Tenant[] }>('/platform/tenants'),
      ]);
      setApplications(apps.data);
      setTenants(tens.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load');
    }
  }, []);

  useEffect(() => {
    if (signedIn) void load();
  }, [signedIn, load]);

  if (!signedIn) return <PlatformLogin onSignedIn={() => setSignedIn(true)} />;

  return (
    <main className="mx-auto max-w-5xl px-6 py-8">
      <header className="mb-6 flex items-baseline gap-4">
        <h1 className="text-xl font-semibold text-text">Provider console</h1>
        <span className="text-xs text-text-subtle">
          Onboarding and subscriptions. No patient data is reachable from here.
        </span>
        <button
          onClick={() => setChangingPassword(true)}
          className="ml-auto text-sm text-primary hover:underline"
        >
          Change password
        </button>
        <button
          onClick={() => {
            setPlatformToken(null);
            setSignedIn(false);
          }}
          className="text-sm text-primary hover:underline"
        >
          Sign out
        </button>
      </header>

      {changingPassword && <PlatformPassword onClose={() => setChangingPassword(false)} />}

      {/*
        The temporary password, shown once and behind a dismissal.
        It is stored only as a hash, so this is the only chance to read it —
        which is why it is not a toast that vanishes on its own.
      */}
      {credentials && (
        <div className="mb-6 rounded-md border border-warning bg-warning-soft px-4 py-3">
          <h2 className="font-semibold text-text">
            {credentials.tenant.name} created — write this down now
          </h2>
          <p className="mt-1 text-sm text-text-muted">
            This password is shown once and cannot be retrieved again. Give it to{' '}
            {credentials.administrator.fullName} directly; they must change it at first sign-in.
            Their code is not secret and they can read it again under Clinic settings.
          </p>
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 font-mono text-sm">
            {/*
              Labelled as their code rather than as an internal identifier.
              The vendor chooses the slug here and the customer never picked
              it, so this is the moment it gets conveyed — and it is the one
              thing another hospital needs in order to send them a
              prescription. Unlike the password it is not secret and is
              readable later in their own clinic settings, so the note says so
              rather than implying this is the only chance.
            */}
            <dt className="text-text-subtle">Their code</dt>
            <dd>{credentials.tenant.slug}</dd>
            <dt className="text-text-subtle">Email</dt>
            <dd>{credentials.administrator.email}</dd>
            <dt className="text-text-subtle">Password</dt>
            <dd className="font-semibold">{credentials.administrator.temporaryPassword}</dd>
          </dl>
          <button
            onClick={() => setCredentials(null)}
            className="mt-3 rounded-md border border-border bg-surface px-3 py-1.5 text-sm"
          >
            I have written this down
          </button>
        </div>
      )}

      <nav className="mb-4 flex gap-2">
        {(['applications', 'tenants'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded-md border px-3 py-1.5 text-sm capitalize ${
              tab === t
                ? 'border-primary bg-primary-soft font-medium text-primary'
                : 'border-border bg-surface text-text-muted'
            }`}
          >
            {t}
            {t === 'applications' && applications && (
              <span className="ml-1.5 text-xs opacity-70">
                {applications.filter((a) => a.status === 'PENDING').length}
              </span>
            )}
          </button>
        ))}
        {tab === 'tenants' && (
          <button
            onClick={() => setCreating(true)}
            className="ml-auto rounded-md bg-primary px-3 py-1.5 text-sm text-white"
          >
            Add a hospital
          </button>
        )}
      </nav>

      {error && <p className="mb-4 text-sm text-danger">{error}</p>}

      {tab === 'applications' && (
        <Applications
          rows={applications}
          onDone={(result) => {
            if (result) setCredentials(result);
            void load();
          }}
          onError={setError}
        />
      )}

      {tab === 'tenants' && (
        <Tenants rows={tenants} onChanged={() => void load()} onError={setError} />
      )}

      {creating && (
        <CreateTenant
          onClose={() => setCreating(false)}
          onCreated={(result) => {
            setCreating(false);
            setCredentials(result);
            void load();
          }}
        />
      )}
    </main>
  );
}

function PlatformLogin({ onSignedIn }: { onSignedIn: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * Recovery, in the two states it has.
   *
   * `?reset=<token>` means they followed the link from the email; otherwise
   * `forgetting` is the request form. Both render *instead of* the sign-in
   * form rather than beside it, because this screen is four controls wide and
   * a third state crammed in is how somebody types their password into the
   * wrong box.
   */
  const [forgetting, setForgetting] = useState(false);
  const [resetAvailable, setResetAvailable] = useState<boolean | null>(null);
  const [resetDelivery, setResetDelivery] = useState<string | null>(null);

  /*
   * Read once, from the URL, and removed from the address bar immediately.
   *
   * A live reset token sitting in `window.location` is one that ends up in
   * browser history, in a screenshot of a support call, and in the `Referer`
   * of anything this page later loads. It is single-use and short-lived, and
   * neither of those is a reason to leave it on display.
   */
  const [resetToken, setResetToken] = useState<string | null>(null);
  useEffect(() => {
    const url = new URL(window.location.href);
    const t = url.searchParams.get('reset');
    if (!t) return;
    setResetToken(t);
    url.searchParams.delete('reset');
    window.history.replaceState({}, '', url.toString());
  }, []);

  useEffect(() => {
    let cancelled = false;
    /*
     * `/platform/auth/capabilities` rather than the hospital `GET /health`,
     * because the console may call nothing but `/platform` —
     * `endpoint-coverage.spec.ts` fails the build on a vendor screen touching a
     * hospital route, and that assertion is worth more than the one saved
     * endpoint.
     *
     * On `platform/auth` rather than `platform`, because the guarded controller
     * would refuse it: this is read by somebody who has no session, which is
     * the whole point. That distinction cost a bug once already — the path here
     * said `/platform/capabilities`, 404'd, and the catch below hid the link in
     * a way indistinguishable from "no mail transport configured".
     */
    platformApi<{ passwordResetAvailable?: boolean; passwordResetDelivery?: string }>(
      '/platform/auth/capabilities',
    )
      .then((body) => {
        if (cancelled) return;
        setResetAvailable(body?.passwordResetAvailable === true);
        setResetDelivery(body?.passwordResetDelivery ?? null);
      })
      .catch((err) => {
        if (cancelled) return;
        /*
         * Hide the link, and say why in the console.
         *
         * The first version of this swallowed the error silently, and that was
         * wrong in exactly the way this codebase keeps recording: the path was
         * `/platform/capabilities` while the route is on the `platform/auth`
         * controller, so it 404'd — and a 404 and "no mail transport
         * configured" rendered as the identical missing link. Two opposite
         * causes, one silent outcome, and no way to tell them apart from the
         * screen.
         *
         * Hiding is still the right default, because an offer that leads
         * nowhere is worse than no offer. What was missing is the sentence
         * that makes it diagnosable in under a minute.
         */
        // eslint-disable-next-line no-console
        console.warn(
          '[platform] could not read password-reset capabilities; hiding the reset link.',
          err,
        );
        setResetAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await platformApi<{ accessToken: string }>('/platform/auth/login', {
        method: 'POST',
        body: { email: email.trim().toLowerCase(), password },
      });
      setPlatformToken(res.accessToken);
      onSignedIn();
    } catch (err) {
      // The server does not distinguish an unknown account from a wrong
      // password, and neither does this.
      setError(err instanceof PlatformApiError ? err.message : 'Could not sign in');
    } finally {
      setBusy(false);
    }
  }

  if (resetToken) {
    return <PlatformChooseNew token={resetToken} onDone={() => setResetToken(null)} />;
  }
  if (forgetting) return <PlatformForgot onBack={() => setForgetting(false)} />;

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6">
      <h1 className="text-xl font-semibold text-text">Provider sign-in</h1>
      <p className="mt-1 text-sm text-text-subtle">
        Vendor staff only. This is not a hospital login.
      </p>
      <form onSubmit={submit} className="mt-6 space-y-3">
        <input
          className="w-full rounded-md border border-border bg-surface px-3 py-2"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoFocus
        />
        <input
          type="password"
          className="w-full rounded-md border border-border bg-surface px-3 py-2"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <p className="text-sm text-danger">{error}</p>}
        <button
          type="submit"
          disabled={busy || !email || !password}
          className="w-full rounded-md bg-primary px-4 py-2 font-medium text-white disabled:opacity-50"
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>

      {/*
        Shown only where a link could actually reach somebody — the same rule
        the hospital login follows. Where it cannot, there is nothing here
        rather than a disabled control explaining itself: the recovery that
        works on such a deployment is `npm run platform:user`, which needs a
        shell, and telling an unauthenticated visitor about the mail
        configuration buys them nothing.
      */}
      {resetAvailable === true && (
        <p className="mt-4 text-center text-sm">
          <button
            type="button"
            onClick={() => setForgetting(true)}
            className="text-text-muted underline"
          >
            Forgot your password?
          </button>
          {resetDelivery === 'log' && (
            <span className="mt-1 block text-xs text-warning">
              Development: the link is printed in the API log, not emailed.
            </span>
          )}
        </p>
      )}
    </main>
  );
}

/**
 * Ask for a console reset link.
 *
 * The response is identical for a real account, an unknown address and a
 * deactivated one — so this screen cannot say more than the server does, and
 * does not try. The list of people who can reach every hospital on a
 * deployment is the worst list here to be able to confirm from outside.
 */
function PlatformForgot({ onBack }: { onBack: () => void }) {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The server's own sentence, held rather than copied — it must not drift. */
  const [sent, setSent] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await platformApi<{ message: string }>('/platform/auth/forgot-password', {
        method: 'POST',
        body: { email: email.trim().toLowerCase() },
      });
      setSent(res.message);
    } catch (err) {
      setError(
        err instanceof PlatformApiError ? err.message : 'Could not send that just now. Try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6">
      <h1 className="text-xl font-semibold text-text">Forgot your console password?</h1>

      {sent ? (
        <>
          <p className="mt-3 text-sm text-text-muted">{sent}</p>
          {/*
            Said before they meet it. Being refused a grant an hour later with
            no warning reads as the console being broken, and somebody
            debugging a refusal they were never told about is how a deliberate
            control gets removed by the next reader.
          */}
          <p className="mt-3 text-xs text-text-subtle">
            After a reset the console works normally, but opening break-glass access into a hospital
            is refused for an hour. Every other console account is told that a reset was asked for —
            this address can reach every hospital on the deployment, so it should not be possible for
            only one person to know.
          </p>
        </>
      ) : (
        <form onSubmit={submit} className="mt-6 space-y-3">
          <p className="text-sm text-text-muted">
            Enter the address on your console account. This is not a hospital sign-in.
          </p>
          <input
            type="email"
            className="w-full rounded-md border border-border bg-surface px-3 py-2"
            placeholder="you@yourcompany.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoFocus
          />
          {error && <p className="text-sm text-danger">{error}</p>}
          <button
            type="submit"
            disabled={busy || !email.trim()}
            className="w-full rounded-md bg-primary px-4 py-2 font-medium text-white disabled:opacity-50"
          >
            {busy ? 'Sending…' : 'Send the link'}
          </button>
        </form>
      )}

      <button onClick={onBack} className="mt-4 text-center text-sm text-primary hover:underline">
        Back to sign in
      </button>
    </main>
  );
}

/** They followed the link. */
function PlatformChooseNew({ token, onDone }: { token: string; onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ blockedFor: number | null } | null>(null);

  /*
   * Checked here as well as on the server, and this one is not redundant: the
   * server has no second field to compare against, so a mistyped password
   * would be accepted, the token spent, and the person locked out with a
   * password they do not know. The only recovery from that is another link.
   */
  const mismatch = confirm.length > 0 && password !== confirm;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await platformApi<{ breakGlassBlockedForMinutes: number | null }>(
        '/platform/auth/reset-password',
        { method: 'POST', body: { token, newPassword: password } },
      );
      setDone({ blockedFor: res.breakGlassBlockedForMinutes });
    } catch (err) {
      // The server names which rule failed — too short, no digit, link expired.
      setError(err instanceof PlatformApiError ? err.message : 'Could not set that password');
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6">
        <h1 className="text-xl font-semibold text-text">Password changed</h1>
        <p className="mt-2 text-sm text-text-muted">Sign in with the new one.</p>
        {done.blockedFor !== null && (
          <p className="mt-3 rounded-md border border-warning bg-warning-soft px-3 py-2 text-xs text-text">
            Break-glass access into a hospital is refused for the next {done.blockedFor} minutes.
            Everything else in the console works. If something is urgent, a colleague can open the
            grant.
          </p>
        )}
        <button
          onClick={onDone}
          className="mt-4 w-full rounded-md bg-primary px-4 py-2 font-medium text-white"
        >
          Sign in
        </button>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6">
      <h1 className="text-xl font-semibold text-text">Choose a new console password</h1>
      <p className="mt-1 text-sm text-text-muted">
        At least 12 characters, with an upper-case letter, a lower-case letter and a digit.
      </p>
      <form onSubmit={submit} className="mt-6 space-y-3">
        <input
          type="password"
          className="w-full rounded-md border border-border bg-surface px-3 py-2"
          placeholder="New password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoFocus
        />
        <input
          type="password"
          className="w-full rounded-md border border-border bg-surface px-3 py-2"
          placeholder="Type it again"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
        {mismatch && <p className="text-sm text-danger">Those do not match.</p>}
        {error && (
          <p className="text-sm text-danger">
            {error}{' '}
            <button type="button" onClick={onDone} className="underline">
              Ask for a new link
            </button>
          </p>
        )}
        <button
          type="submit"
          disabled={busy || password.length < 12 || mismatch || !confirm}
          className="w-full rounded-md bg-primary px-4 py-2 font-medium text-white disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Set password'}
        </button>
      </form>
    </main>
  );
}

/**
 * Which modules a hospital is being onboarded with.
 *
 * Shared by approval and direct creation, because the decision is the same one
 * and two copies of a checkbox list is how the role list ended up hand-written
 * in four places with three of them wrong.
 *
 * Everything is ticked by default. The common customer is a whole hospital, and
 * a picker that starts empty makes the reviewer restate the obvious on every
 * approval — which is how somebody eventually creates a customer whose first
 * hour is a product that refuses to book an appointment.
 */
function ModulePicker({
  chosen,
  onChange,
}: {
  chosen: TenantModule[];
  onChange: (modules: TenantModule[]) => void;
}) {
  return (
    <fieldset className="mt-3">
      <legend className="mb-1 text-xs text-text-subtle">
        Modules — what they are being sold. Changeable afterwards, and nothing is ever deleted by
        changing it.
      </legend>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {ALL_MODULES.map((module) => (
          <label key={module} className="flex items-center gap-1.5 text-sm">
            <input
              type="checkbox"
              checked={chosen.includes(module)}
              onChange={() =>
                onChange(
                  chosen.includes(module)
                    ? chosen.filter((m) => m !== module)
                    : [...chosen, module],
                )
              }
            />
            {MODULE_LABEL[module]}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function Applications({
  rows,
  onDone,
  onError,
}: {
  rows: Application[] | null;
  onDone: (result: Provisioned | null) => void;
  onError: (message: string) => void;
}) {
  const [busyId, setBusyId] = useState<number | null>(null);
  const [rejecting, setRejecting] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  // Keyed by application, so opening a second one does not inherit the first's
  // choice. Absent means "the reviewer has not touched it", and the fallback is
  // then what the applicant asked for — see `defaultModules`.
  const [modules, setModules] = useState<Record<number, TenantModule[]>>({});

  /**
   * What the picker opens on: their answer if they gave one, otherwise all five.
   *
   * It used to be all five unconditionally, which quietly handed a pharmacy the
   * wards and the clinic — the reviewer had to notice the mismatch and correct
   * it by hand on every application, and a default nobody adjusted is the
   * commonest way a hospital ends up with a menu of screens it never bought.
   *
   * Still fully editable, and that is the point rather than a caveat: **the
   * vendor decides what was sold.** The applicant's answer is a request, like
   * the slug, and this is a pre-fill rather than an instruction — somebody who
   * asked for everything and is being sold a pilot gets the pilot.
   *
   * An empty array falls back to all five deliberately. "Did not say" must not
   * silently become "wants nothing", which would provision a hospital with no
   * screens at all — legal in the model, and a bad first hour for a customer
   * whose application simply skipped an optional question.
   */
  function defaultModules(a: Application): TenantModule[] {
    return a.requestedModules?.length ? a.requestedModules : ALL_MODULES;
  }

  if (!rows) return <p className="text-sm text-text-muted">Loading…</p>;
  if (rows.length === 0) return <p className="text-sm text-text-muted">No requests yet.</p>;

  async function approve(a: Application) {
    setBusyId(a.id);
    try {
      const result = await platformApi<Provisioned>(`/platform/applications/${a.id}/approve`, {
        method: 'POST',
        body: { modules: modules[a.id] ?? defaultModules(a) },
      });
      onDone(result);
    } catch (e) {
      // A slug collision lands here, and the server names it. Approving again
      // after picking a different address is the fix.
      onError(e instanceof Error ? e.message : 'Could not approve');
    } finally {
      setBusyId(null);
    }
  }

  async function reject(id: number) {
    setBusyId(id);
    try {
      await platformApi(`/platform/applications/${id}/reject`, {
        method: 'POST',
        body: { reason: reason.trim() },
      });
      setRejecting(null);
      setReason('');
      onDone(null);
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Could not reject');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-3">
      {rows.map((a) => (
        <article key={a.id} className="rounded-md border border-border bg-surface p-4">
          <div className="flex items-baseline gap-2">
            <h3 className="font-medium text-text">{a.hospitalName}</h3>
            <span className="text-xs uppercase tracking-wide text-text-subtle">{a.status}</span>
            {/* The public form deliberately cannot tell an applicant they have
                already applied — that would let anyone enumerate customers. So
                the duplicate surfaces here, where it is useful and harmless. */}
            {a.duplicateOfEmail && (
              <span className="rounded-sm bg-warning-soft px-1.5 text-xxs text-warning">
                more than one request from this address
              </span>
            )}
            <span className="ml-auto text-xs text-text-subtle">
              {new Date(a.createdAt).toLocaleDateString()}
            </span>
          </div>

          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-sm">
            <dt className="text-text-subtle">Contact</dt>
            <dd>
              {a.contactName} · {a.contactEmail}
              {a.contactPhone ? ` · ${a.contactPhone}` : ''}
            </dd>
            {a.requestedSlug && (
              <>
                <dt className="text-text-subtle">Wants</dt>
                <dd className="font-mono text-xs">{a.requestedSlug}</dd>
              </>
            )}
            {/*
              * What they said they run, as *their* answer rather than as the
              * picker's state — the two diverge the moment the reviewer edits
              * it, and which is which is exactly what somebody needs to see
              * before approving. Absent when they skipped the question, because
              * "Asked for: everything" would put words in their mouth.
              */}
            {a.requestedModules?.length ? (
              <>
                <dt className="text-text-subtle">Asked for</dt>
                <dd>{a.requestedModules.map((m) => MODULE_LABEL[m]).join(' · ')}</dd>
              </>
            ) : null}
            {a.notes && (
              <>
                <dt className="text-text-subtle">Notes</dt>
                <dd className="whitespace-pre-wrap text-text-muted">{a.notes}</dd>
              </>
            )}
            {a.reviewNote && (
              <>
                <dt className="text-text-subtle">Reason</dt>
                <dd className="text-text-muted">{a.reviewNote}</dd>
              </>
            )}
          </dl>

          {a.status === 'PENDING' && (
            <ModulePicker
              chosen={modules[a.id] ?? defaultModules(a)}
              onChange={(next) => setModules((m) => ({ ...m, [a.id]: next }))}
            />
          )}

          {a.status === 'PENDING' && (
            <div className="mt-3 flex items-center gap-2">
              <button
                onClick={() => void approve(a)}
                disabled={busyId === a.id}
                className="rounded-md bg-primary px-3 py-1.5 text-sm text-white disabled:opacity-50"
              >
                Approve and create
              </button>
              <button
                onClick={() => setRejecting(rejecting === a.id ? null : a.id)}
                className="rounded-md border border-border px-3 py-1.5 text-sm"
              >
                Reject
              </button>
            </div>
          )}

          {rejecting === a.id && (
            <div className="mt-2">
              <textarea
                className="w-full rounded-md border border-border bg-bg px-3 py-2 text-sm"
                rows={2}
                placeholder="Why — kept on record, and read by whoever handles them if they apply again"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
              <button
                onClick={() => void reject(a.id)}
                disabled={reason.trim().length < 10 || busyId === a.id}
                className="mt-1 rounded-md bg-danger px-3 py-1.5 text-sm text-white disabled:opacity-50"
              >
                Confirm rejection
              </button>
            </div>
          )}
        </article>
      ))}
    </div>
  );
}

function Tenants({
  rows,
  onChanged,
  onError,
}: {
  rows: Tenant[] | null;
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const [open, setOpen] = useState<{ id: number; panel: Panel } | null>(null);

  if (!rows) return <p className="text-sm text-text-muted">Loading…</p>;
  if (rows.length === 0) return <p className="text-sm text-text-muted">No hospitals yet.</p>;

  return (
    <div className="overflow-hidden rounded-md border border-border">
      <table className="w-full text-sm">
        <thead className="bg-bg text-left text-xs uppercase text-text-subtle">
          <tr>
            <th className="px-3 py-2">Hospital</th>
            <th className="px-3 py-2">Address</th>
            <th className="px-3 py-2 text-right">Users</th>
            <th className="px-3 py-2 text-right">Patients</th>
            <th className="px-3 py-2">Subscription</th>
            <th className="px-3 py-2">Modules</th>
            <th className="px-3 py-2" />
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <TenantRow
              key={t.id}
              tenant={t}
              panel={open?.id === t.id ? open.panel : null}
              onOpen={(panel) =>
                setOpen(open?.id === t.id && open.panel === panel ? null : { id: t.id, panel })
              }
              onChanged={onChanged}
              onError={onError}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Which drawer is open under a hospital's row. */
type Panel = 'subscription' | 'modules' | 'access';

function TenantRow({
  tenant,
  panel,
  onOpen,
  onChanged,
  onError,
}: {
  tenant: Tenant;
  panel: Panel | null;
  onOpen: (panel: Panel) => void;
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const [status, setStatus] = useState(tenant.subscriptionStatus);
  const [endsAt, setEndsAt] = useState(tenant.subscriptionEndsAt?.slice(0, 10) ?? '');
  const [note, setNote] = useState(tenant.subscriptionNote ?? '');
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      await platformApi(`/platform/tenants/${tenant.id}/subscription`, {
        method: 'PATCH',
        body: {
          status,
          // Explicit null clears it and means open-ended. An invoiced hospital
          // with no fixed renewal is normal, not a missing value.
          endsAt: endsAt ? new Date(`${endsAt}T23:59:59Z`).toISOString() : null,
          note: note.trim() || null,
        },
      });
      onOpen('subscription');
      onChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Could not update the subscription');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <tr className={`border-t border-border ${tenant.canWrite ? '' : 'bg-danger-soft'}`}>
        <td className="px-3 py-2 font-medium">{tenant.name}</td>
        <td className="px-3 py-2 font-mono text-xs text-text-muted">{tenant.slug}</td>
        <td className="px-3 py-2 text-right font-mono text-xs">{tenant.users}</td>
        <td className="px-3 py-2 text-right font-mono text-xs">{tenant.patients}</td>
        <td className="px-3 py-2 text-xs">
          <span className={tenant.canWrite ? 'text-text-muted' : 'font-semibold text-danger'}>
            {tenant.subscriptionStatus.replace('_', ' ')}
          </span>
          {/* Says what is actually happening to them, not just a status name.
              "Read-only" is the fact a support call will be about. */}
          {!tenant.canWrite && <span className="ml-1.5 text-danger">· read-only</span>}
          {tenant.canWrite && tenant.daysRemaining !== null && tenant.daysRemaining <= 14 && (
            <span className="ml-1.5 text-warning">· {tenant.daysRemaining}d left</span>
          )}
        </td>
        <td className="px-3 py-2 text-xs">
          {/*
            Named, not counted. "3 of 5" tells a vendor on a support call
            nothing they can act on — the question is always "do they have the
            laboratory", and only the names answer it.
          */}
          {tenant.modules.length === 0 ? (
            <span className="text-warning">none</span>
          ) : (
            <span className="text-text-muted">
              {tenant.modules.map((m) => MODULE_LABEL[m]).join(' · ')}
            </span>
          )}
        </td>
        <td className="px-3 py-2 text-right whitespace-nowrap">
          <button
            onClick={() => onOpen('subscription')}
            className="text-xs text-primary hover:underline"
          >
            {panel === 'subscription' ? 'Cancel' : 'Subscription'}
          </button>
          <button
            onClick={() => onOpen('modules')}
            className="ml-3 text-xs text-primary hover:underline"
          >
            {panel === 'modules' ? 'Cancel' : 'Modules'}
          </button>
          {/* Deliberately last and deliberately not styled as a primary
              action. Opening a grant is the one thing here that reaches
              *inside* a hospital, and it should read as the exception it is. */}
          <button
            onClick={() => onOpen('access')}
            className="ml-3 text-xs text-primary hover:underline"
          >
            {panel === 'access' ? 'Cancel' : 'Access'}
          </button>
        </td>
      </tr>

      {panel === 'access' && (
        <tr className="border-t border-border bg-bg">
          <td colSpan={7} className="px-3 py-3">
            <AccessPanel tenant={tenant} onError={onError} />
          </td>
        </tr>
      )}

      {panel === 'modules' && (
        <tr className="border-t border-border bg-bg">
          <td colSpan={7} className="px-3 py-3">
            {/*
              Deliberately left open after saving. The stranded-record count
              only exists in the response, so closing the drawer on success
              would throw away the one thing the vendor most needs to read —
              the same shape as a toast carrying a temporary password.
            */}
            <ModulesPanel tenant={tenant} onDone={onChanged} onError={onError} />
          </td>
        </tr>
      )}

      {panel === 'subscription' && (
        <tr className="border-t border-border bg-bg">
          <td colSpan={7} className="px-3 py-3">
            <div className="flex flex-wrap items-end gap-3">
              <label className="text-xs">
                <span className="mb-1 block text-text-subtle">Status</span>
                <select
                  className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm"
                  value={status}
                  onChange={(e) => setStatus(e.target.value as Tenant['subscriptionStatus'])}
                >
                  {STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {s.replace('_', ' ')}
                    </option>
                  ))}
                </select>
              </label>

              <label className="text-xs">
                <span className="mb-1 block text-text-subtle">Ends (blank = open-ended)</span>
                <input
                  type="date"
                  className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm"
                  value={endsAt}
                  onChange={(e) => setEndsAt(e.target.value)}
                />
              </label>

              <label className="flex-1 text-xs">
                <span className="mb-1 block text-text-subtle">Note (never shown to them)</span>
                <input
                  className="w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="PO number, who signed, why extended"
                />
              </label>

              <button
                onClick={() => void save()}
                disabled={busy}
                className="rounded-md bg-primary px-3 py-1.5 text-sm text-white disabled:opacity-50"
              >
                {busy ? 'Saving…' : 'Save'}
              </button>
            </div>

            <p className="mt-2 text-xs text-text-subtle">
              Suspending stops new entries being saved. It never blocks signing in and never hides
              a patient record — staff keep full read access to everything they already have.
            </p>
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * A vendor account changing its own password.
 *
 * This was the only credential in the product that could not be changed from
 * inside it — `npm run platform:user` upserts, so rotating one meant shell
 * access to the server, which means in practice it never happened. It is also
 * the most powerful password on the deployment: it can open a break-glass grant
 * against any hospital.
 *
 * There is deliberately no "forgot password" beside it, and there should not
 * be: a reset link emailed to a vendor address is a way into every hospital on
 * the deployment guarded by one mailbox. Recovery here stays a person with
 * database access.
 */
function PlatformPassword({ onClose }: { onClose: () => void }) {
  const [currentPassword, setCurrent] = useState('');
  const [newPassword, setNext] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await platformApi('/platform/password', {
        method: 'POST',
        body: { currentPassword, newPassword },
      });
      setDone(true);
    } catch (err) {
      // The server names which rule failed — too short, no digit, same as the
      // current one. Showing a generic "could not change" instead would leave
      // somebody guessing at a rule the response already told us.
      setError(err instanceof Error ? err.message : 'Could not change the password');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-6 max-w-md rounded-md border border-border bg-surface px-4 py-3">
      {done ? (
        <>
          <p className="text-sm text-text">Password changed.</p>
          <p className="mt-1 text-xs text-text-muted">
            Your current session keeps working — platform sign-in issues a short-lived token and no
            refresh token, so there is nothing to sign out of.
          </p>
          <button onClick={onClose} className="mt-2 text-sm text-primary hover:underline">
            Close
          </button>
        </>
      ) : (
        <form onSubmit={submit}>
          <h2 className="text-sm font-semibold text-text">Change your console password</h2>
          <label className="mt-2 block text-xs">
            <span className="mb-1 block text-text-subtle">Current password</span>
            <input
              type="password"
              className="w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm"
              value={currentPassword}
              onChange={(e) => setCurrent(e.target.value)}
              autoComplete="current-password"
            />
          </label>
          <label className="mt-2 block text-xs">
            <span className="mb-1 block text-text-subtle">
              New password (12+ characters, with upper, lower and a digit)
            </span>
            <input
              type="password"
              className="w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm"
              value={newPassword}
              onChange={(e) => setNext(e.target.value)}
              autoComplete="new-password"
            />
          </label>

          {error && (
            <p role="alert" className="mt-2 text-xs text-danger">
              {error}
            </p>
          )}

          <div className="mt-3 flex gap-2">
            <button
              type="submit"
              disabled={busy || !currentPassword || newPassword.length < 12}
              className="rounded-md bg-primary px-3 py-1.5 text-sm text-white disabled:opacity-50"
            >
              {busy ? 'Changing…' : 'Change password'}
            </button>
            <button type="button" onClick={onClose} className="text-sm text-primary hover:underline">
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

/* ── break-glass, and the one write it buys ──────────────────────────────── */

type Administrator = {
  id: number;
  email: string;
  fullName: string;
  isActive: boolean;
  lastLoginAt: string | null;
  lockedUntil: string | null;
  mustChangePassword: boolean;
};

type Grant = { id: number; minutesRemaining: number };

/**
 * Getting a hospital back in when its only administrator is locked out.
 *
 * WHY THIS SCREEN EXISTS AT ALL
 * -----------------------------
 * Break-glass has been modelled since the platform API was written and had **no
 * console** — it was curl-only, and "curl-only" is how a capability quietly
 * stops being one. The reset underneath it would have been the same: a route
 * nobody could reach, which is the shape this project has reopened eight times.
 *
 * WHAT A GRANT ACTUALLY BUYS
 * --------------------------
 * Aggregates, configuration, and — now — resetting an administrator's password.
 * Not a patient row; there is no route that returns one. The panel says so,
 * because a vendor engineer who believes they are looking at clinical data will
 * behave differently from one who knows they are not.
 *
 * WHY THE REASON IS TYPED BEFORE ANYTHING IS SEEN
 * ----------------------------------------------
 * It is written into the *hospital's* audit log, and it is the sentence
 * somebody there reads when they ask why the vendor was in their system. A
 * reason collected afterwards is one written to justify what already happened.
 */
function AccessPanel({ tenant, onError }: { tenant: Tenant; onError: (m: string) => void }) {
  const [reason, setReason] = useState('');
  const [ticketRef, setTicketRef] = useState('');
  const [grant, setGrant] = useState<Grant | null>(null);
  const [admins, setAdmins] = useState<Administrator[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [resetting, setResetting] = useState<number | null>(null);
  /** Shown once, and never fetched again — only the hash is kept. */
  const [issued, setIssued] = useState<{ email: string; password: string; isActive: boolean } | null>(
    null,
  );

  async function loadAdmins() {
    const res = await platformApi<{ administrators: Administrator[]; grant: Grant }>(
      `/platform/tenants/${tenant.id}/administrators`,
    );
    setAdmins(res.administrators);
    setGrant(res.grant);
  }

  async function openGrant() {
    setBusy(true);
    try {
      await platformApi('/platform/break-glass', {
        method: 'POST',
        body: {
          tenantId: tenant.id,
          reason: reason.trim(),
          ticketRef: ticketRef.trim() || undefined,
        },
      });
      await loadAdmins();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Could not open access');
    } finally {
      setBusy(false);
    }
  }

  async function reset(a: Administrator) {
    setResetting(a.id);
    try {
      const res = await platformApi<{
        email: string;
        temporaryPassword: string;
        isActive: boolean;
      }>(`/platform/tenants/${tenant.id}/users/${a.id}/reset-password`, { method: 'POST' });
      setIssued({ email: res.email, password: res.temporaryPassword, isActive: res.isActive });
      await loadAdmins();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Could not reset that password');
    } finally {
      setResetting(null);
    }
  }

  async function revoke() {
    if (!grant) return;
    setBusy(true);
    try {
      await platformApi(`/platform/break-glass/${grant.id}`, { method: 'DELETE' });
      setGrant(null);
      setAdmins(null);
      setIssued(null);
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Could not revoke that grant');
    } finally {
      setBusy(false);
    }
  }

  if (!grant) {
    return (
      <div className="max-w-2xl">
        <p className="text-xs text-text-muted">
          Reaching inside {tenant.name} needs a reason, and it expires on its own. Everything you do
          under it is written into <strong>their</strong> audit log, not ours — so they can answer
          &ldquo;who from the vendor was in our system, when, and why&rdquo; from their own records.
        </p>
        <p className="mt-1 text-xs text-text-subtle">
          It buys aggregates, clinic settings, and resetting an administrator&rsquo;s password. There
          is no route that returns a patient record.
        </p>

        <label className="mt-3 block text-xs">
          <span className="mb-1 block text-text-subtle">
            Why (at least 12 characters — they will read this)
          </span>
          <textarea
            className="w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm"
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Owner cannot sign in, confirmed identity by phone with Dr Rao"
          />
        </label>

        <label className="mt-2 block text-xs">
          <span className="mb-1 block text-text-subtle">Ticket reference (optional)</span>
          <input
            className="w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm"
            value={ticketRef}
            onChange={(e) => setTicketRef(e.target.value)}
          />
        </label>

        <button
          onClick={() => void openGrant()}
          disabled={busy || reason.trim().length < 12}
          className="mt-3 rounded-md bg-primary px-3 py-1.5 text-sm text-white disabled:opacity-50"
        >
          {busy ? 'Opening…' : 'Open access'}
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-3xl">
      <div className="flex items-center gap-3 text-xs">
        <span className="rounded-full bg-warning-soft px-2 py-0.5 font-semibold text-warning">
          Access open · {grant.minutesRemaining}m left
        </span>
        <button onClick={() => void revoke()} disabled={busy} className="text-primary hover:underline">
          Close it now
        </button>
      </div>

      {issued && (
        /*
          Held on screen until dismissed rather than shown in a toast. The
          password exists in exactly one place for exactly as long as this is
          open — there is no second reading, so a notification that fades is the
          wrong shape for it. Same reasoning as the provisioning credential.
        */
        <div className="mt-3 rounded-md border border-primary bg-primary-soft px-3 py-2">
          <p className="text-xs text-text-muted">Read this out now. It is not shown again.</p>
          <p className="mt-1 font-mono text-sm">{issued.email}</p>
          <p className="font-mono text-lg font-semibold">{issued.password}</p>
          <p className="mt-1 text-xs text-text-muted">
            They will be asked to choose a new one before anything else loads. Every session they
            had has been signed out.
          </p>
          {!issued.isActive && (
            <p className="mt-1 text-xs font-semibold text-danger">
              This account is deactivated, so it still cannot sign in. Another administrator has to
              reactivate it first.
            </p>
          )}
          <button
            onClick={() => setIssued(null)}
            className="mt-2 text-xs text-primary hover:underline"
          >
            Done
          </button>
        </div>
      )}

      <p className="mt-3 text-xs text-text-subtle">
        Administrators only. Everybody else at this hospital is reset by their own administrator,
        from Admin → Users.
      </p>

      {admins?.length === 0 && (
        /*
          Provisioning creates a hospital and its first administrator in one
          transaction, so this should be impossible — which is exactly why it is
          worth rendering rather than leaving as an empty list somebody reads as
          "still loading".
        */
        <p className="mt-2 text-xs text-danger">
          This hospital has no account holding ADMIN. Nobody can administer it; it needs one created
          directly in the database.
        </p>
      )}

      <div className="mt-2 overflow-hidden rounded-md border border-border">
        <table className="w-full text-sm">
          <tbody>
            {(admins ?? []).map((a) => (
              <tr key={a.id} className="border-t border-border first:border-t-0">
                <td className="px-3 py-2">
                  <div className="font-medium">{a.fullName}</div>
                  <div className="font-mono text-xs text-text-muted">{a.email}</div>
                </td>
                <td className="px-3 py-2 text-xs text-text-muted">
                  {a.lastLoginAt ? `last in ${a.lastLoginAt.slice(0, 10)}` : 'never signed in'}
                  {!a.isActive && <span className="ml-2 text-danger">deactivated</span>}
                  {a.mustChangePassword && (
                    <span className="ml-2 text-primary">password pending</span>
                  )}
                  {a.lockedUntil && new Date(a.lockedUntil) > new Date() && (
                    <span className="ml-2 text-warning">locked out</span>
                  )}
                </td>
                <td className="px-3 py-2 text-right">
                  <button
                    onClick={() => void reset(a)}
                    disabled={resetting !== null}
                    className="rounded-md border border-border px-2 py-1 text-xs hover:bg-bg disabled:opacity-50"
                  >
                    {resetting === a.id ? 'Resetting…' : 'Reset password'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * What a hospital has been sold.
 *
 * WHY A SET OF TICKBOXES AND NOT A PLAN NAME
 * ------------------------------------------
 * A plan is a commercial fact that changes for reasons this system does not
 * model — a discount, a pilot, a clinic that bought the laboratory a year after
 * the practice. The question the code always asks is "does this hospital have
 * the laboratory", and a set answers it without anybody having to add an enum
 * member the day somebody sells a new combination.
 *
 * REMOVING ONE IS NOT A DELETION, AND THE PANEL SAYS SO
 * ----------------------------------------------------
 * `ModuleGuard` refuses writes and never a read, which is the same line the
 * subscription holds and for the same reason: a clinician cannot un-know that a
 * test was run, and the person harmed by hiding the record is a doctor with a
 * patient in front of them rather than whoever took the commercial decision.
 *
 * That has to be on the screen, because "remove the laboratory" reads as
 * destructive and is not, and a vendor who believes it is destructive will
 * refuse to do a thing that is safe.
 *
 * THE CONFIRMATION IS BEFORE, THE COUNT IS AFTER
 * ----------------------------------------------
 * The removal is named before it happens; how much data sits behind it comes
 * back with the response. That asymmetry is real and worth knowing: the count
 * is reported so the vendor learns what they have just made read-only, not so
 * they can decide beforehand. A preview would want its own endpoint, and
 * inventing one to soften a reversible change was not worth the route.
 *
 * It is reversible in the ordinary way — tick it again and the writes resume,
 * with nothing to restore, because nothing was removed.
 */
function ModulesPanel({
  tenant,
  onDone,
  onError,
}: {
  tenant: Tenant;
  onDone: () => void;
  onError: (message: string) => void;
}) {
  const [chosen, setChosen] = useState<TenantModule[]>(tenant.modules);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<ModulesChanged | null>(null);

  const removing = tenant.modules.filter((m) => !chosen.includes(m));
  const adding = chosen.filter((m) => !tenant.modules.includes(m));
  const changed = removing.length > 0 || adding.length > 0;

  function toggle(module: TenantModule) {
    setConfirming(false);
    setResult(null);
    setChosen((current) =>
      current.includes(module) ? current.filter((m) => m !== module) : [...current, module],
    );
  }

  async function save() {
    setBusy(true);
    try {
      /*
       * The complete set, never a delta. Two vendors with the console open
       * would otherwise apply two half-changes to a row neither of them read,
       * and the result would be a hospital holding a combination nobody chose.
       */
      const changedTo = await platformApi<ModulesChanged>(
        `/platform/tenants/${tenant.id}/modules`,
        { method: 'PATCH', body: { modules: chosen } },
      );
      setResult(changedTo);
      setConfirming(false);
      onDone();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Could not change the modules');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {ALL_MODULES.map((module) => {
          const on = chosen.includes(module);
          return (
            <label
              key={module}
              className={`flex cursor-pointer gap-2 rounded-md border p-2 text-xs ${
                on ? 'border-primary bg-surface' : 'border-border'
              }`}
            >
              <input
                type="checkbox"
                className="mt-0.5"
                checked={on}
                onChange={() => toggle(module)}
              />
              <span>
                <span className="block font-medium">{MODULE_LABEL[module]}</span>
                <span className="block text-text-subtle">{MODULE_DESCRIPTION[module]}</span>
              </span>
            </label>
          );
        })}
      </div>

      {/*
        The floor, stated where somebody is about to untick the last box.
        A tenant with no modules is a legal and useful thing — a hospital
        mid-onboarding — and it is not a broken one, so the screen should not
        look like it is refusing.
      */}
      {chosen.length === 0 && (
        <p className="text-xs text-warning">
          None selected. They keep patients, staff accounts, clinic settings and their audit log —
          every customer has those — and can create nothing else.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={() => (confirming || removing.length === 0 ? void save() : setConfirming(true))}
          disabled={busy || !changed}
          className="rounded-md bg-primary px-3 py-1.5 text-sm text-white disabled:opacity-50"
        >
          {busy
            ? 'Saving…'
            : confirming
              ? `Yes, remove ${removing.map((m) => MODULE_LABEL[m]).join(' and ')}`
              : 'Save'}
        </button>

        {changed && !confirming && (
          <span className="text-xs text-text-subtle">
            {adding.length > 0 && <>Adding {adding.map((m) => MODULE_LABEL[m]).join(', ')}. </>}
            {removing.length > 0 && (
              <>Removing {removing.map((m) => MODULE_LABEL[m]).join(', ')}.</>
            )}
          </span>
        )}

        {confirming && (
          <span className="text-xs text-warning">
            {removing.map((m) => MODULE_LABEL[m]).join(' and ')} disappears for their staff — the
            screens go, and the records in it stop being reachable. Nothing is deleted, and ticking
            it again brings all of it straight back.
          </span>
        )}
      </div>

      {result && (
        <div className="rounded-md border border-border bg-surface p-2 text-xs">
          <p className="font-medium">Saved.</p>
          {result.strandedRecords.length === 0 ? (
            <p className="text-text-subtle">
              {result.removed.length === 0
                ? 'Their menu changes the next time somebody signs in.'
                : 'Nothing had been recorded in what was removed.'}
            </p>
          ) : (
            <ul className="mt-1 space-y-0.5 text-text-subtle">
              {result.strandedRecords.map((r) => (
                <li key={r.module}>
                  {r.records.toLocaleString()} {MODULE_LABEL[r.module].toLowerCase()} records are
                  now out of reach — kept, not deleted, and readable again the moment the module
                  goes back.
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <p className="text-xs text-text-subtle">
        Modules are what they bought; the subscription is whether they have paid — and the two do
        different things. A lapsed subscription stops writes and never hides a record. Removing a
        module takes the whole area away, screens and records together, which is why this asks
        before it does it. A role whose module is gone stops being offered for new staff; anybody
        already holding it keeps their account and their history.
      </p>
    </div>
  );
}

function CreateTenant({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (result: Provisioned) => void;
}) {
  const [form, setForm] = useState({
    hospitalName: '',
    slug: '',
    adminEmail: '',
    adminName: '',
    timezone: 'UTC',
    currency: 'USD',
    trialDays: '',
  });
  const [modules, setModules] = useState<TenantModule[]>(ALL_MODULES);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [k]: e.target.value });

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const result = await platformApi<Provisioned>('/platform/tenants', {
        method: 'POST',
        body: {
          hospitalName: form.hospitalName.trim(),
          slug: form.slug.trim().toLowerCase() || undefined,
          adminEmail: form.adminEmail.trim(),
          adminName: form.adminName.trim(),
          timezone: form.timezone.trim() || undefined,
          currency: form.currency.trim() || undefined,
          trialDays: form.trialDays ? Number(form.trialDays) : undefined,
          modules,
        },
      });
      onCreated(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create that hospital');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 px-6">
      <div className="w-full max-w-md rounded-md border border-border bg-surface p-5">
        <h2 className="font-semibold text-text">Add a hospital</h2>
        <p className="mt-1 text-xs text-text-subtle">
          Creates the hospital and its first administrator in one step. The temporary password is
          shown once.
        </p>

        <div className="mt-4 space-y-3">
          {(
            [
              ['hospitalName', 'Hospital name', 'St Mary’s Clinic'],
              ['slug', 'Web address (optional)', 'st-marys'],
              ['adminName', 'Administrator name', 'Jane Okafor'],
              ['adminEmail', 'Administrator email', 'jane@example.com'],
              ['timezone', 'Timezone', 'Asia/Kolkata'],
              ['currency', 'Currency', 'INR'],
              ['trialDays', 'Trial days (blank = open-ended)', '30'],
            ] as const
          ).map(([key, label, placeholder]) => (
            <label key={key} className="block text-xs">
              <span className="mb-1 block text-text-subtle">{label}</span>
              <input
                className="w-full rounded-md border border-border bg-bg px-3 py-2 text-sm"
                value={form[key]}
                onChange={set(key)}
                placeholder={placeholder}
              />
            </label>
          ))}
        </div>

        {/* The timezone matters more than it looks: a hospital left on the
            wrong one gets a clinic day that ends before its staff arrive and a
            booking page offering only past slots, which presents as a bug in
            booking rather than a wrong setting. */}
        <p className="mt-2 text-xxs text-text-subtle">
          Timezone must be an IANA name like Asia/Kolkata. Abbreviations such as IST are ambiguous
          and ignore daylight saving.
        </p>

        <ModulePicker chosen={modules} onChange={setModules} />

        {error && <p className="mt-3 text-sm text-danger">{error}</p>}

        <div className="mt-4 flex gap-2">
          <button
            onClick={() => void submit()}
            disabled={busy || !form.hospitalName || !form.adminEmail || !form.adminName}
            className="rounded-md bg-primary px-3 py-1.5 text-sm text-white disabled:opacity-50"
          >
            {busy ? 'Creating…' : 'Create'}
          </button>
          <button onClick={onClose} className="rounded-md border border-border px-3 py-1.5 text-sm">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
