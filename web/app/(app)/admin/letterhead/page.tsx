'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import type { Letterhead } from '@/lib/types';
import { Button, ErrorState, Field, Input, Textarea } from '@/components/ui/primitives';

/**
 * What this hospital prints at the top of anything a patient carries away.
 *
 * WHY THIS SCREEN EXISTS
 * ----------------------
 * The prescription renderer had `<h1>Meridian Hospital</h1>` written into it —
 * the demo seed's name, printed on every tenant's prescriptions. A patient
 * walked into a pharmacy holding a document naming a hospital they had never
 * attended, and a pharmacist has no way to tell a rendering fault from a
 * forgery. Everything else in this system is tenant-scoped by construction; the
 * one artefact that leaves the building was not.
 *
 * A one-off setup task, so web-only on the same line as departments and staff
 * accounts. You do it once, at a desk, with the hospital's letterhead in front
 * of you.
 */
const MAX_LOGO_BYTES = 150_000;

export default function LetterheadPage() {
  const [form, setForm] = useState<Letterhead | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setForm(await api<Letterhead>('/letterhead'));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the letterhead');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function set<K extends keyof Letterhead>(key: K, value: Letterhead[K]) {
    setForm((f) => (f ? { ...f, [key]: value } : f));
    setSaved(false);
  }

  async function pickLogo(file: File) {
    setError(null);
    /*
     * Checked here as well as on the server, because the useful message is the
     * one that arrives before a 30-second upload rather than after it. The
     * server refuses the same things regardless — the client is not the
     * boundary.
     */
    if (!/^image\/(png|jpeg)$/.test(file.type)) {
      setError('The logo must be a PNG or JPEG. Those are the two formats the PDF can embed.');
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      setError(
        `That image is ${Math.round(file.size / 1024)}KB. Use one under ${MAX_LOGO_BYTES / 1000}KB — it only prints about 20mm wide.`,
      );
      return;
    }
    const reader = new FileReader();
    reader.onload = () => set('logoDataUrl', String(reader.result));
    reader.onerror = () => setError('Could not read that file');
    reader.readAsDataURL(file);
  }

  async function save() {
    if (!form) return;
    setBusy(true);
    setError(null);
    try {
      // Empty strings are sent deliberately: that is how a field is cleared.
      // Omitting them would mean "unchanged" and leave no way to remove an
      // address line or a logo short of a database console.
      const { name, ...rest } = form;
      void name; // read-only here — the hospital's name is set at provisioning
      setForm(await api<Letterhead>('/letterhead', { method: 'PATCH', body: rest }));
      setSaved(true);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not save the letterhead');
    } finally {
      setBusy(false);
    }
  }

  if (error && !form) return <ErrorState message={error} onRetry={() => void load()} />;
  if (!form) return null;

  return (
    <div className="scroll-thin flex-1 overflow-y-auto p-4">
      <div className="mb-4 max-w-3xl">
        <h1 className="text-lg font-semibold text-text">Letterhead</h1>
        <p className="mt-1 text-sm text-text-subtle">
          Printed at the top of every prescription, invoice and consultation note this hospital
          produces. Every field is optional — a document with only your name still prints.
        </p>
      </div>

      {error && (
        <div
          role="alert"
          className="mb-3 max-w-3xl rounded-sm border border-[#f2c4be] bg-danger-soft px-2.5 py-2 text-sm text-[#8a2a1f]"
        >
          {error}
        </div>
      )}
      {saved && (
        <div className="mb-3 max-w-3xl rounded-sm border border-[#b7dcc5] bg-success-soft px-2.5 py-2 text-sm text-[#14562f]">
          Saved. Print any prescription to see it.
        </div>
      )}

      <div className="grid max-w-3xl gap-5 md:grid-cols-[1fr_260px]">
        <div className="space-y-3">
          <Field
            label="Hospital name"
            hint="Set when your account was created. Contact support to change it."
          >
            <Input value={form.name} disabled readOnly />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Address line 1">
              <Input
                value={form.addressLine1 ?? ''}
                onChange={(e) => set('addressLine1', e.target.value)}
              />
            </Field>
            <Field label="Address line 2">
              <Input
                value={form.addressLine2 ?? ''}
                onChange={(e) => set('addressLine2', e.target.value)}
              />
            </Field>
            <Field label="City">
              <Input value={form.city ?? ''} onChange={(e) => set('city', e.target.value)} />
            </Field>
            <Field label="Postcode">
              <Input value={form.postcode ?? ''} onChange={(e) => set('postcode', e.target.value)} />
            </Field>
            <Field label="Country">
              <Input value={form.country ?? ''} onChange={(e) => set('country', e.target.value)} />
            </Field>
            <Field label="Phone">
              <Input
                value={form.contactPhone ?? ''}
                onChange={(e) => set('contactPhone', e.target.value)}
              />
            </Field>
            <Field label="Email">
              <Input
                value={form.contactEmail ?? ''}
                onChange={(e) => set('contactEmail', e.target.value)}
              />
            </Field>
            <Field label="Website">
              <Input value={form.website ?? ''} onChange={(e) => set('website', e.target.value)} />
            </Field>
          </div>

          <Field
            label="Hospital registration / licence number"
            hint="Printed in the header. Required on a prescription in many jurisdictions."
          >
            <Input
              value={form.registrationNo ?? ''}
              onChange={(e) => set('registrationNo', e.target.value)}
            />
          </Field>

          <Field
            label="Footer"
            hint="Small print: tax number, complaints address, anything your regulator wants at the bottom."
          >
            <Textarea
              rows={2}
              value={form.footerText ?? ''}
              onChange={(e) => set('footerText', e.target.value)}
            />
          </Field>

          <div className="flex gap-2 pt-1">
            <Button variant="primary" disabled={busy} onClick={() => void save()}>
              {busy ? 'Saving…' : 'Save letterhead'}
            </Button>
          </div>
        </div>

        {/*
          A live preview, because a letterhead is judged by looking at it and
          the alternative is saving, printing a prescription, and coming back.
          Deliberately the same order and emphasis as the PDF rather than a
          prettier arrangement — a preview that flatters is worse than none.
        */}
        <div>
          <h2 className="mb-1.5 text-xxs font-bold uppercase tracking-wider text-text-subtle">
            Preview
          </h2>
          <div className="rounded-md border border-border bg-white p-3">
            <div className="flex gap-2.5">
              {form.logoDataUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={form.logoDataUrl}
                  alt="Logo"
                  className="h-12 w-12 shrink-0 object-contain"
                />
              )}
              <div className="min-w-0">
                <div className="truncate text-sm font-bold text-black">{form.name}</div>
                {[form.addressLine1, form.addressLine2]
                  .filter(Boolean)
                  .map((l) => (
                    <div key={l} className="truncate text-xxs text-[#555]">
                      {l}
                    </div>
                  ))}
                {(form.city || form.postcode) && (
                  <div className="truncate text-xxs text-[#555]">
                    {[form.city, form.postcode].filter(Boolean).join(' ')}
                  </div>
                )}
                {form.country && <div className="text-xxs text-[#555]">{form.country}</div>}
                {[form.contactPhone, form.contactEmail, form.website].some(Boolean) && (
                  <div className="truncate text-xxs text-[#555]">
                    {[form.contactPhone, form.contactEmail, form.website]
                      .filter(Boolean)
                      .join('  ·  ')}
                  </div>
                )}
                {form.registrationNo && (
                  <div className="text-xxs text-[#555]">Reg. no: {form.registrationNo}</div>
                )}
              </div>
            </div>
            <div className="mt-2 border-t-2 border-black pt-1.5 text-xxs font-bold text-black">
              PRESCRIPTION <span className="font-normal text-[#555]">#1042</span>
            </div>
            {form.footerText && (
              <div className="mt-6 border-t border-[#ddd] pt-1 text-center text-[7px] text-[#555]">
                {form.footerText}
              </div>
            )}
          </div>

          <div className="mt-3 space-y-2">
            <input
              ref={fileInput}
              type="file"
              accept="image/png,image/jpeg"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void pickLogo(f);
                e.target.value = '';
              }}
            />
            <Button className="w-full" onClick={() => fileInput.current?.click()}>
              {form.logoDataUrl ? 'Replace logo' : 'Upload logo'}
            </Button>
            {form.logoDataUrl && (
              <Button variant="danger" className="w-full" onClick={() => set('logoDataUrl', '')}>
                Remove logo
              </Button>
            )}
            <p className="text-xxs text-text-subtle">
              PNG or JPEG, under {MAX_LOGO_BYTES / 1000}KB. It prints about 20mm wide, so a small
              square image is ideal. Remember to save.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
