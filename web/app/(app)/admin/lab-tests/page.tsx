'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import type { LabAnalyte, LabCategory, LabSpecimenType, LabTest } from '@/lib/types';
import { titleCase } from '@/lib/format';
import {
  Button,
  EmptyState,
  ErrorState,
  Field,
  Input,
  SectionLabel,
  Select,
  TableSkeleton,
} from '@/components/ui/primitives';
import { Sheet } from '@/components/ui/sheet';

const CATEGORIES: LabCategory[] = [
  'HAEMATOLOGY',
  'BIOCHEMISTRY',
  'MICROBIOLOGY',
  'SEROLOGY',
  'HISTOPATHOLOGY',
  'IMAGING',
  'OTHER',
];

const SPECIMENS: LabSpecimenType[] = [
  'BLOOD',
  'URINE',
  'STOOL',
  'SWAB',
  'SPUTUM',
  'TISSUE',
  'FLUID',
  'NONE',
];

interface AnalyteDraft {
  name: string;
  unit: string;
  refLow: string;
  refHigh: string;
  refText: string;
  criticalLow: string;
  criticalHigh: string;
}

const EMPTY_ANALYTE: AnalyteDraft = {
  name: '',
  unit: '',
  refLow: '',
  refHigh: '',
  refText: '',
  criticalLow: '',
  criticalHigh: '',
};

/**
 * The test catalogue an administrator sets up.
 *
 * WHY THIS SCREEN EXISTS AT ALL
 * -----------------------------
 * Three times on this project a table has been writable only by the demo seed —
 * the medicine catalogue, `Doctor` profiles, wards — so every hospital that
 * arrived through the platform had an empty table and no route to a first row.
 * Each was found on a real deployment, by a user, never by a test, because an
 * empty table and an unbuilt feature render identically.
 *
 * A hospital with no test catalogue cannot order a single investigation, and
 * the symptom would surface two roles away as a doctor's ordering sheet with
 * nothing in it. `self-provisionable.spec.ts` now asserts this route exists.
 *
 * WHY THE REFERENCE RANGES ARE HERE AND NOT HARD-CODED
 * ---------------------------------------------------
 * Ranges differ by laboratory, by analyser and by population. They are a
 * property of the lab that produced the number, not of the analyte. A built-in
 * table would be wrong somewhere on day one and would stay wrong silently — and
 * a flag computed from a wrong range is worse than no flag, because it reads as
 * a laboratory having checked.
 *
 * A test with no analytes is ordinary rather than unfinished: that is what an
 * X-ray is, and it reports as narrative only.
 */
export default function AdminLabTestsPage() {
  const [tests, setTests] = useState<LabTest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<LabTest | 'new' | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      // Inactive rows included: a retired test has to be findable in order to
      // be brought back, and a list that hides it makes re-adding it fail as a
      // duplicate against a row nobody can see.
      const res = await api<{ data: LabTest[] }>('/lab-tests?includeInactive=true');
      setTests(res.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the catalogue');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error && !tests) return <ErrorState message={error} onRetry={() => void load()} />;

  return (
    <div className="scroll-thin flex-1 overflow-y-auto p-4">
      <div className="mb-4 flex items-start justify-between">
        <div>
          <h1 className="text-lg font-semibold text-text">Lab tests</h1>
          <p className="text-sm text-text-muted">
            What your laboratory offers, what it charges, and what counts as normal.
          </p>
        </div>
        <Button variant="primary" onClick={() => setEditing('new')}>
          + Add test
        </Button>
      </div>

      {!tests ? (
        <TableSkeleton rows={5} />
      ) : tests.length === 0 ? (
        <EmptyState
          title="No tests yet"
          description="Until you add one, nobody can request an investigation — the doctor's ordering sheet will be empty and will say so. Start with the handful your clinic actually runs."
        />
      ) : (
        <div className="overflow-hidden rounded-md border border-border">
          <table className="w-full text-sm">
            <thead className="bg-bg text-left text-xs uppercase text-text-subtle">
              <tr>
                <th className="px-3 py-2">Code</th>
                <th className="px-3 py-2">Test</th>
                <th className="px-3 py-2">Category</th>
                <th className="px-3 py-2">Analytes</th>
                <th className="px-3 py-2 text-right">Price</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {tests.map((t) => (
                <tr key={t.id} className={`border-t border-border ${t.isActive ? '' : 'opacity-50'}`}>
                  <td className="px-3 py-2 font-mono text-xs">{t.code}</td>
                  <td className="px-3 py-2">
                    <span className="font-medium">{t.name}</span>
                    {!t.isActive && (
                      <span className="ml-2 text-xxs uppercase text-text-subtle">retired</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-text-muted">{titleCase(t.category)}</td>
                  <td className="px-3 py-2 text-xs text-text-muted">
                    {t.analytes.length === 0 ? 'narrative only' : t.analytes.length}
                  </td>
                  <td className="px-3 py-2 text-right text-xs">
                    {/* Blank is not zero, and the two must not render alike. */}
                    {t.sellingPrice ?? <span className="text-danger">Not priced</span>}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      onClick={() => setEditing(t)}
                      className="text-xs text-primary hover:underline"
                    >
                      Edit
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <TestSheet
          test={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

function TestSheet({
  test,
  onClose,
  onSaved,
}: {
  test: LabTest | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [code, setCode] = useState(test?.code ?? '');
  const [name, setName] = useState(test?.name ?? '');
  const [category, setCategory] = useState<LabCategory>(test?.category ?? 'BIOCHEMISTRY');
  const [specimenType, setSpecimenType] = useState<LabSpecimenType>(test?.specimenType ?? 'BLOOD');
  const [sellingPrice, setSellingPrice] = useState(test?.sellingPrice ?? '');
  const [turnaroundHours, setTurnaroundHours] = useState(
    test?.turnaroundHours ? String(test.turnaroundHours) : '',
  );
  const [preparation, setPreparation] = useState(test?.preparation ?? '');
  const [isActive, setIsActive] = useState(test?.isActive ?? true);
  const [analytes, setAnalytes] = useState<AnalyteDraft[]>(
    (test?.analytes ?? []).map(toDraft),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<string[]>([]);

  const setAnalyte = (i: number, k: keyof AnalyteDraft, v: string) =>
    setAnalytes((prev) => prev.map((a, idx) => (idx === i ? { ...a, [k]: v } : a)));

  /**
   * Two endpoints, two DTOs, two bodies built separately.
   *
   * THE BUG THIS SHAPE CAUSED
   * -------------------------
   * The first version built one `body` object and sent it to both, adding
   * `code` for the create. That is one line shorter and it 400d on every
   * create, because `isActive` is on `UpdateLabTestDto` and not on
   * `CreateLabTestDto` — a new test is offered by definition, so there is
   * nothing to decide — and the global `ValidationPipe` runs with
   * `forbidNonWhitelisted: true`.
   *
   * That setting is right and it did its job: a client sending a field the API
   * does not know about is a bug worth surfacing rather than swallowing. What
   * was wrong was feeding two different contracts from one literal, which makes
   * the two look interchangeable when they are not — and would do it again on
   * the next field either one gains.
   */
  const analyteBody = () =>
    analytes
      .filter((a) => a.name.trim())
      .map((a, i) => ({
        name: a.name.trim(),
        unit: a.unit.trim() || null,
        refLow: a.refLow.trim() || null,
        refHigh: a.refHigh.trim() || null,
        refText: a.refText.trim() || null,
        criticalLow: a.criticalLow.trim() || null,
        criticalHigh: a.criticalHigh.trim() || null,
        position: i,
      }));

  async function save() {
    setBusy(true);
    setError(null);
    setFieldErrors([]);
    try {
      const shared = {
        name: name.trim(),
        category,
        specimenType,
        // Empty clears the price rather than setting zero. `@IsOptional()`
        // accepts null, and the service tells "not sent" from "sent as null".
        sellingPrice: sellingPrice.trim() || null,
        turnaroundHours: turnaroundHours.trim() ? Number(turnaroundHours) : null,
        preparation: preparation.trim() || null,
        analytes: analyteBody(),
      };

      if (test) {
        // `isActive` only here: retiring a test is an edit, never a creation.
        await api(`/lab-tests/${test.id}`, { method: 'PATCH', body: { ...shared, isActive } });
      } else {
        await api('/lab-tests', { method: 'POST', body: { ...shared, code: code.trim() } });
      }

      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not save that test');
      /*
       * The field-by-field reasons, not just "Bad Request".
       *
       * A 400 from the validation pipe already says exactly which field failed
       * and why. Showing only `message` gives an administrator a red box on a
       * form with twenty inputs telling them something is wrong and not which
       * thing — the same failure the vitals form had, reported from use.
       */
      setFieldErrors(e instanceof ApiError ? (e.errors ?? []) : []);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title={test ? `${test.code} — ${test.name}` : 'Add a test'}
      footer={
        <>
          <Button
            variant="primary"
            disabled={busy || !name.trim() || (!test && !code.trim())}
            onClick={() => void save()}
          >
            {busy ? 'Saving…' : 'Save'}
          </Button>
          <Button onClick={onClose}>Cancel</Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-2.5">
        <Field label="Code" required hint="Short. It goes on a worklist and a specimen label.">
          <Input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            disabled={test !== null}
            placeholder="FBC"
            className="font-mono"
          />
        </Field>
        <Field label="Name" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Full blood count" />
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-2.5">
        <Field label="Category">
          <Select value={category} onChange={(e) => setCategory(e.target.value as LabCategory)}>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {titleCase(c)}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Specimen"
          hint="“None” for imaging — the workflow then skips collection instead of waiting for a sample that does not exist."
        >
          <Select
            value={specimenType}
            onChange={(e) => setSpecimenType(e.target.value as LabSpecimenType)}
          >
            {SPECIMENS.map((s) => (
              <option key={s} value={s}>
                {s === 'NONE' ? 'None (imaging)' : titleCase(s)}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-2.5">
        <Field
          label="Price"
          hint="Leave empty if you do not charge for it. Empty is not the same as 0 — an empty price means the test is performed and not billed, and is reported back as such."
        >
          <Input
            value={sellingPrice}
            onChange={(e) => setSellingPrice(e.target.value)}
            placeholder="0.00"
          />
        </Field>
        <Field label="Turnaround (hours)" hint="Shown to the doctor when they order it.">
          <Input
            type="number"
            value={turnaroundHours}
            onChange={(e) => setTurnaroundHours(e.target.value)}
            placeholder="24"
          />
        </Field>
      </div>

      <Field
        label="Patient preparation"
        hint="Shown at the moment of ordering. The commonest cause of a wasted sample is nobody having said this."
      >
        <Input
          value={preparation}
          onChange={(e) => setPreparation(e.target.value)}
          placeholder="Fasting, 8 hours. Purple-top EDTA."
        />
      </Field>

      {test && (
        <label className="mt-2 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
          {/* Retired, not deleted. Orders already raised record what they
              ordered as text, but the row is what a reader follows back to a
              price and a range. */}
          Offered. Turning this off retires the test — existing reports keep working.
        </label>
      )}

      <SectionLabel>Analytes and reference ranges</SectionLabel>
      <p className="-mt-1 mb-2 text-xs text-text-muted">
        One row per measured value. Leave this empty for imaging or histopathology — those report as
        findings and an impression. <strong>A range you do not set is not treated as normal</strong>
        : the value is recorded and reported with no flag, so an unconfigured test never looks like a
        clean result.
      </p>

      {analytes.map((a, i) => (
        <div key={i} className="mb-2 rounded-sm border border-border p-2.5">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-xxs font-semibold uppercase tracking-wider text-text-subtle">
              Analyte {i + 1}
            </span>
            <button
              onClick={() => setAnalytes((prev) => prev.filter((_, idx) => idx !== i))}
              className="text-xs text-danger hover:underline"
            >
              Remove
            </button>
          </div>

          <div className="grid grid-cols-2 gap-2.5">
            <Field label="Name" required>
              <Input
                value={a.name}
                onChange={(e) => setAnalyte(i, 'name', e.target.value)}
                placeholder="Haemoglobin"
              />
            </Field>
            <Field label="Unit">
              <Input
                value={a.unit}
                onChange={(e) => setAnalyte(i, 'unit', e.target.value)}
                placeholder="g/L"
              />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-2.5">
            <Field label="Normal from">
              <Input value={a.refLow} onChange={(e) => setAnalyte(i, 'refLow', e.target.value)} />
            </Field>
            <Field label="Normal to">
              <Input value={a.refHigh} onChange={(e) => setAnalyte(i, 'refHigh', e.target.value)} />
            </Field>
          </div>

          <Field
            label="Expected value, in words"
            hint="For anything not a number — “No growth”, “Negative”. Use this instead of a range."
          >
            <Input
              value={a.refText}
              onChange={(e) => setAnalyte(i, 'refText', e.target.value)}
              placeholder="No growth"
            />
          </Field>

          <div className="grid grid-cols-2 gap-2.5">
            <Field
              label="Critical below"
              hint="Leave empty unless somebody genuinely has to be telephoned."
            >
              <Input
                value={a.criticalLow}
                onChange={(e) => setAnalyte(i, 'criticalLow', e.target.value)}
              />
            </Field>
            <Field label="Critical above">
              <Input
                value={a.criticalHigh}
                onChange={(e) => setAnalyte(i, 'criticalHigh', e.target.value)}
              />
            </Field>
          </div>
        </div>
      ))}

      <Button className="w-full" onClick={() => setAnalytes((prev) => [...prev, { ...EMPTY_ANALYTE }])}>
        + Add analyte
      </Button>

      {test && analytes.length > 0 && (
        /* Said before saving, because the consequence is invisible afterwards.
           Replacing rather than merging is deliberate — a half-applied range
           flags values against limits that are neither the old ones nor the new
           — but somebody editing one row should know the rest go with it. */
        <p className="mt-2 text-xs text-text-subtle">
          Saving replaces every analyte on this test. Results already issued keep the range they
          were judged against — they captured it when they were entered.
        </p>
      )}

      {error && (
        <div
          role="alert"
          className="mt-3 rounded-sm border border-[#f2c4be] bg-danger-soft px-2.5 py-2 text-sm text-[#8a2a1f]"
        >
          {error}
          {fieldErrors.length > 0 && (
            <ul className="mt-1 list-disc pl-4 text-xs">
              {fieldErrors.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Sheet>
  );
}

function toDraft(a: LabAnalyte): AnalyteDraft {
  return {
    name: a.name,
    unit: a.unit ?? '',
    refLow: a.refLow ?? '',
    refHigh: a.refHigh ?? '',
    refText: a.refText ?? '',
    criticalLow: a.criticalLow ?? '',
    criticalHigh: a.criticalHigh ?? '',
  };
}
