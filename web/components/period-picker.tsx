'use client';

import { useEffect, useState } from 'react';

/**
 * The period a statement covers.
 *
 * WHY THIS IS NOT A MONTH PICKER
 * ------------------------------
 * Reported by the product owner: *"Some partner lab may have, as an agreement,
 * a statement every week or every ten days or biweekly."* That is how referral
 * contracts are actually written, and `<input type="month">` cannot express any
 * of them. A laboratory on a weekly agreement was left reading four weeks of
 * lines and adding up the ones inside the week by eye — which is the work the
 * statement exists to remove, reappearing one level in.
 *
 * WHY THREE PRESETS AND NOT FIVE
 * ------------------------------
 * The first version offered seven days, ten days, fourteen days, this month and
 * last month, on the reasoning that each named cadence should be one click. The
 * product owner cut it to three, and the cut is right: **the dates underneath do
 * the general case better than a chip ever will**. Ten-daily and fortnightly are
 * two dates either way — a chip for them only helps on the one day of the cycle
 * it happens to be correct on, and on any other day it silently answers a
 * different question than the one asked. A row of five near-identical chips also
 * has to be *read* before it can be used, which is the opposite of what a shortcut
 * is for.
 *
 * What is left is the three that are genuinely not expressible as "pick two
 * dates I already know": this month and last month have ends that move with the
 * calendar, and the last seven days is the one rolling window people ask for by
 * name.
 *
 * WHY THE DATES ARE ALWAYS VISIBLE
 * --------------------------------
 * They used to hide behind a *Custom* button, so the general case — the one the
 * whole feature exists for — was a click further away than the shortcuts to it.
 * They are now the control and the chips are the shortcut: a preset fills the
 * two boxes in and you can see what it filled in. That matters beyond tidiness,
 * because a preset computes "today" from the *browser's* clock while the server
 * resolves the period in the *hospital's* timezone. Those agree for everybody
 * sitting in their own clinic and can differ by a day for somebody who is not —
 * and a filled-in box that is one day out is correctable, where a hidden one is
 * not.
 *
 * WHY BOTH ENDS ARE ALWAYS SENT
 * -----------------------------
 * The server refuses one end without the other rather than guessing "until
 * today" or "from the start of that month". A period on a financial document
 * has two boundaries and neither should be inferred on somebody's behalf. So a
 * half-filled range is **held here** rather than sent: the refusal is correct
 * and arriving as a red API error while somebody is still typing the second
 * date is not.
 *
 * The days are the **hospital's** calendar days, resolved server-side. A client
 * deciding what "the last seven days" means across a timezone boundary is
 * exactly how a referral accessioned at 23:40 lands on the wrong statement.
 */
export interface Period {
  from: string;
  to: string;
}

/** `2026-09-01` for a `Date`, in the browser's own calendar. */
function key(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

function daysBack(n: number): Period {
  const to = new Date();
  const from = new Date();
  /*
   * `n - 1`, so "last 7 days" is seven days including today rather than eight.
   * The off-by-one here bills a day twice across consecutive weekly cycles,
   * which is the error a preset exists to prevent.
   */
  from.setDate(from.getDate() - (n - 1));
  return { from: key(from), to: key(to) };
}

function lastMonth(): Period {
  const now = new Date();
  return {
    from: key(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
    to: key(new Date(now.getFullYear(), now.getMonth(), 0)),
  };
}

const PRESETS: { label: string; period: () => Period | null }[] = [
  /*
   * Null, not this month's two dates. The server resolves an absent period as
   * the hospital's own month — so the commonest case is the one place the
   * browser's clock is never consulted at all. Filling the boxes in with dates
   * computed here would take that guarantee away to make the chip look like the
   * other two.
   */
  { label: 'This month', period: () => null },
  { label: 'Last month', period: lastMonth },
  { label: 'Last 7 days', period: () => daysBack(7) },
];

export function PeriodPicker({
  value,
  onChange,
  /** What the server resolved it to — printed so the two cannot silently differ. */
  label,
  busy,
}: {
  value: Period | null;
  onChange: (next: Period | null) => void;
  label?: string;
  busy?: boolean;
}) {
  /*
   * The boxes hold a draft, and only a *complete, ordered* pair reaches the
   * parent. Typing a start date makes the range momentarily half-written and
   * momentarily backwards, and neither is a period anybody asked for.
   */
  const [draft, setDraft] = useState<Period>({ from: value?.from ?? '', to: value?.to ?? '' });

  // A preset writes the boxes too. Without this the chips and the fields would
  // disagree, and the fields are the ones a person believes.
  useEffect(() => {
    setDraft({ from: value?.from ?? '', to: value?.to ?? '' });
  }, [value?.from, value?.to]);

  const half = (draft.from === '') !== (draft.to === '');
  // Lexicographic on `YYYY-MM-DD` is chronological, which is the whole reason
  // the wire format is that and not `01/09/2026`.
  const backwards = draft.from !== '' && draft.to !== '' && draft.to < draft.from;

  function edit(next: Period) {
    setDraft(next);
    if (next.from === '' && next.to === '') {
      onChange(null);
      return;
    }
    if (next.from === '' || next.to === '' || next.to < next.from) return;
    onChange(next);
  }

  return (
    <div className="mb-3">
      <div className="flex flex-wrap items-center gap-2">
        {PRESETS.map((p) => {
          const period = p.period();
          const active =
            period === null
              ? value === null && draft.from === '' && draft.to === ''
              : value !== null && value.from === period.from && value.to === period.to;
          return (
            <button
              key={p.label}
              onClick={() => {
                setDraft({ from: period?.from ?? '', to: period?.to ?? '' });
                onChange(period);
              }}
              className={`rounded-full border px-3 py-1 text-xs ${
                active
                  ? 'border-primary bg-primary-soft font-semibold text-primary'
                  : 'border-border text-text-muted hover:border-primary'
              }`}
            >
              {p.label}
            </button>
          );
        })}

        <div className="flex items-center gap-1.5">
          <label className="text-xs text-text-subtle" htmlFor="period-from">
            From
          </label>
          <input
            id="period-from"
            type="date"
            value={draft.from}
            onChange={(e) => edit({ ...draft, from: e.target.value })}
            className="rounded-md border border-border bg-surface px-2 py-1 text-sm"
          />
          <label className="text-xs text-text-subtle" htmlFor="period-to">
            to
          </label>
          <input
            id="period-to"
            type="date"
            value={draft.to}
            min={draft.from || undefined}
            onChange={(e) => edit({ ...draft, to: e.target.value })}
            className="rounded-md border border-border bg-surface px-2 py-1 text-sm"
          />
          {(draft.from || draft.to) && (
            <button
              onClick={() => {
                setDraft({ from: '', to: '' });
                onChange(null);
              }}
              className="text-xs text-text-muted underline hover:text-text"
            >
              Reset
            </button>
          )}
        </div>

        {/*
          The server's own words for the period, beside the controls that chose
          it. A statement carries no number, so the period *is* its identity —
          and a screen that shows the inputs while the page says something else
          is how two parties come to disagree about which days a bill covers.
        */}
        {label && (
          <span className="ml-auto text-sm text-text-muted">
            {busy ? 'Loading…' : label}
          </span>
        )}
      </div>

      {/*
        Said here rather than left to the API. The server refuses both of these
        and its refusal is right; meeting it as a red error bar while you are
        halfway through choosing the second date teaches people that the screen
        is broken.
      */}
      {(half || backwards) && (
        <p className="mt-1.5 text-xs text-warning">
          {backwards
            ? 'The period ends before it starts — still showing the last one.'
            : 'Pick both ends of the period. A statement has two boundaries and neither is guessed.'}
        </p>
      )}
    </div>
  );
}

/** `?from=&to=`, or empty for "this month". Kept here so both screens agree. */
export function periodQuery(period: Period | null): string {
  if (!period?.from || !period.to) return '';
  return `?from=${encodeURIComponent(period.from)}&to=${encodeURIComponent(period.to)}`;
}
