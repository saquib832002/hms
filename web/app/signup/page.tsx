'use client';

import { useState } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { SIGNUP_BUNDLES } from '@/lib/types';

/**
 * Ask to become a customer.
 *
 * PUBLIC, AND THEREFORE NOT DENSE
 * -------------------------------
 * Every internal screen in this app is deliberately dense — sidebars, tables,
 * many rows on one screen — because staff live in it for eight-hour shifts.
 * This is the exception CLAUDE.md carves out: a public-facing page stays light.
 * The person reading it has no account, no training and no reason to persist.
 *
 * FOUR REQUIRED FIELDS
 * --------------------
 * Every extra question on a form that has not yet given anybody anything loses
 * a share of the people filling it in. Bed count, staff numbers and department
 * lists are a phone call, not a form.
 *
 * WHAT IT DOES NOT TELL YOU
 * -------------------------
 * Whether this email has applied before, and whether the requested address is
 * free. Both would be genuinely useful and both would turn a public form into a
 * way to enumerate the vendor's customers. The reviewer sees duplicates and
 * collisions instead — see `signup.controller.ts`.
 */
export default function SignupPage() {
  const [form, setForm] = useState({
    hospitalName: '',
    contactName: '',
    contactEmail: '',
    contactPhone: '',
    requestedSlug: '',
    notes: '',
  });

  /**
   * Which shape of business they are, held as the bundle id rather than the
   * module set — so re-rendering cannot lose which radio is ticked, and the set
   * is derived at submit from the one table both clients share.
   *
   * Empty is a legitimate answer and stays one: nothing is required here, and
   * "did not say" reaches the reviewer as an empty array rather than as a guess.
   */
  const [bundle, setBundle] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm({ ...form, [k]: e.target.value });

  const valid =
    form.hospitalName.trim().length >= 2 &&
    form.contactName.trim().length >= 2 &&
    /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.contactEmail.trim());

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/public/signup', {
        method: 'POST',
        body: {
          hospitalName: form.hospitalName.trim(),
          contactName: form.contactName.trim(),
          contactEmail: form.contactEmail.trim(),
          contactPhone: form.contactPhone.trim() || undefined,
          requestedSlug: form.requestedSlug.trim().toLowerCase() || undefined,
          /*
           * The *set*, never the bundle id. `Tenant.modules` is a set rather
           * than a plan name on purpose, and sending an id would put a
           * commercial label into the data model that the backend would then
           * have to translate — and would have to keep translating the same way
           * forever, including for a bundle nobody sells any more.
           */
          requestedModules: SIGNUP_BUNDLES.find((b) => b.id === bundle)?.modules,
          notes: form.notes.trim() || undefined,
        },
        // Nobody is signed in. Without this the client would try to refresh a
        // session that does not exist and turn a clean 4xx into a redirect.
        skipRefresh: true,
      });
      setDone(true);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'Could not send that just now. Please try again in a moment.',
      );
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center px-6 py-16">
        <h1 className="text-2xl font-semibold text-text">Thank you</h1>
        <p className="mt-3 text-text-muted">
          Your request has been received. Someone will contact you at the address you gave.
        </p>
        <p className="mt-6 text-sm text-text-subtle">
          Already have an account?{' '}
          <Link href="/login" className="text-primary hover:underline">
            Sign in
          </Link>
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-lg px-6 py-16">
      <h1 className="text-2xl font-semibold text-text">Request an account</h1>
      <p className="mt-2 text-text-muted">
        Tell us about your hospital and we will be in touch. Nothing is set up until we have
        spoken.
      </p>

      <form onSubmit={submit} className="mt-8 space-y-4">
        <Field label="Hospital or clinic name" required>
          <input
            className="w-full rounded-md border border-border bg-surface px-3 py-2"
            value={form.hospitalName}
            onChange={set('hospitalName')}
            autoFocus
            maxLength={200}
          />
        </Field>

        <Field label="Your name" required>
          <input
            className="w-full rounded-md border border-border bg-surface px-3 py-2"
            value={form.contactName}
            onChange={set('contactName')}
            maxLength={120}
          />
        </Field>

        <Field label="Email" required hint="We reply here. Nothing is sent to anyone else.">
          <input
            type="email"
            className="w-full rounded-md border border-border bg-surface px-3 py-2"
            value={form.contactEmail}
            onChange={set('contactEmail')}
            maxLength={200}
          />
        </Field>

        <Field label="Phone">
          <input
            className="w-full rounded-md border border-border bg-surface px-3 py-2"
            value={form.contactPhone}
            onChange={set('contactPhone')}
            maxLength={40}
          />
        </Field>

        {/*
         * This was labelled "Preferred web address", and that was false rather
         * than merely unclear — the slug appears in **no URL anywhere** in this
         * product. There are no per-hospital subdomains and no tenant path
         * segment; it was checked against every use before this was reworded.
         *
         * What it actually is, in the two places anybody meets it:
         *
         *  - **The code another hospital identifies you by.** Partnerships start
         *    offline — a pharmacy or laboratory gives out its code and the other
         *    hospital types it in, because a browsable directory of every
         *    customer is the enumeration problem this form already avoids.
         *  - **What staff type at sign-in if they hold accounts at two
         *    hospitals**, since an email address is unique per hospital and
         *    login will not guess between them.
         *
         * So it is closer to a trading name than to an address, which is what
         * the product owner suspected when they asked what the field was for —
         * and a label somebody has to ask about is a label that has failed.
         */}
        <Field
          label="Short code for your hospital"
          hint="Optional — we can pick one for you. Lowercase letters, numbers and hyphens. Partner pharmacies and laboratories use it to identify you, and your staff type it at sign-in if they have accounts at two hospitals."
        >
          <div className="flex items-center gap-1.5">
            <input
              className="w-full rounded-md border border-border bg-surface px-3 py-2 font-mono text-sm"
              value={form.requestedSlug}
              onChange={set('requestedSlug')}
              placeholder="st-marys"
              maxLength={60}
            />
          </div>
          {/* Deliberately no live availability check: it would let anyone probe
              which hospitals already use the product. If it is taken we will
              say so when we reply. */}
        </Field>

        {/*
         * What they are, in their words — see `SIGNUP_BUNDLES`.
         *
         * Optional, and the label says so. A required question here would turn
         * away anybody unsure which line describes them, and the reviewer can
         * ask on the telephone; an unanswered one is honestly empty rather than
         * defaulted to everything.
         *
         * Radios rather than a `<select>`: six options whose *differences* are
         * the point, and a closed dropdown hides five of them behind a click.
         */}
        <fieldset className="rounded-md border border-border p-3">
          <legend className="px-1 text-sm font-medium text-text">
            What do you run? <span className="font-normal text-text-muted">(optional)</span>
          </legend>
          <p className="mb-2 text-xs text-text-muted">
            So we set you up with the parts you need and leave out the rest. We can change it later.
          </p>
          <div className="space-y-2">
            {SIGNUP_BUNDLES.map((b) => (
              <label key={b.id} className="flex cursor-pointer gap-2.5">
                <input
                  type="radio"
                  name="bundle"
                  className="mt-1"
                  checked={bundle === b.id}
                  onChange={() => setBundle(b.id)}
                />
                <span>
                  <span className="block text-sm font-medium text-text">{b.label}</span>
                  <span className="block text-xs text-text-muted">{b.hint}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <Field label="Anything else" hint="How many staff, what you need, where you heard about us.">
          <textarea
            className="w-full rounded-md border border-border bg-surface px-3 py-2"
            rows={4}
            value={form.notes}
            onChange={set('notes')}
            maxLength={2000}
          />
        </Field>

        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={!valid || busy}
          className="w-full rounded-md bg-primary px-4 py-2.5 font-medium text-white disabled:opacity-50"
        >
          {busy ? 'Sending…' : 'Send request'}
        </button>

        <p className="text-center text-sm text-text-subtle">
          Already have an account?{' '}
          <Link href="/login" className="text-primary hover:underline">
            Sign in
          </Link>
        </p>
      </form>
    </main>
  );
}

function Field({
  label,
  required,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-text">
        {label}
        {required && <span className="ml-0.5 text-danger">*</span>}
      </span>
      {children}
      {hint && <span className="mt-1 block text-xs text-text-subtle">{hint}</span>}
    </label>
  );
}
