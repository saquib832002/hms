'use client';

import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import type { Medicine } from '@/lib/types';
import { Input } from '@/components/ui/primitives';

/**
 * Find a medicine by typing two or three characters of its name.
 *
 * WHY THIS REPLACED A DROPDOWN
 * ----------------------------
 * Stock intake used `<Select>` over every medicine in the catalogue. That works
 * for the demo seed and fails for a real pharmacy: a catalogue is hundreds to
 * thousands of lines, and a native select is a scroll through all of them with
 * no search worth the name. The pharmacist is holding a carton with the name
 * printed on it — typing three characters is the fastest possible input, and
 * the screen was asking them to hunt instead.
 *
 * SEARCHED ON THE SERVER, NOT FILTERED IN THE BROWSER
 * ---------------------------------------------------
 * `GET /medicines?q=` already existed and already limits its result set. The
 * alternative — fetch the whole catalogue once and filter in memory — is the
 * pattern the prescribing type-ahead uses, and it is defensible there because
 * a doctor's screen already holds the catalogue for other reasons. Here it
 * would mean downloading every medicine to type into one box, and it degrades
 * silently: it works in testing against 40 rows and gets slower every month
 * without ever breaking, which is the kind of problem nobody files.
 *
 * WHAT IT WILL NOT DO
 * -------------------
 * It will not accept free text. Unlike prescribing — where the catalogue is a
 * convenience and a doctor may write anything — stock has to attach to a real
 * `medicineId`, because a batch of something that is not in the catalogue can
 * never be dispensed or counted. So selection is required, and "nothing
 * matches" points at adding the medicine rather than letting the name through.
 */
export function MedicinePicker({
  value,
  onChange,
  autoFocus,
}: {
  /** The chosen medicine, or null. Owned by the caller. */
  value: Medicine | null;
  onChange: (medicine: Medicine | null) => void;
  autoFocus?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Medicine[] | null>(null);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [searching, setSearching] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  /*
   * Two characters before anything is fetched.
   *
   * One character matches a large fraction of any catalogue, so the request is
   * expensive and the list it returns is useless. Debounced at 200ms so typing
   * a full name is one request rather than eight.
   */
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults(null);
      setSearching(false);
      return;
    }

    setSearching(true);
    const timer = setTimeout(() => {
      let cancelled = false;
      void api<{ data: Medicine[] }>(`/medicines?q=${encodeURIComponent(q)}`)
        .then((r) => {
          if (cancelled) return;
          /*
           * Names that *start* with what was typed come first. Someone typing
           * "amo" wants Amoxicillin above Co-amoxiclav; the server orders
           * alphabetically, which buries the obvious answer.
           */
          const lower = q.toLowerCase();
          setResults(
            [...r.data].sort((a, b) => {
              const aStarts = a.name.toLowerCase().startsWith(lower) ? 0 : 1;
              const bStarts = b.name.toLowerCase().startsWith(lower) ? 0 : 1;
              return aStarts - bStarts || a.name.localeCompare(b.name);
            }),
          );
          setHighlight(0);
        })
        .catch(() => {
          if (!cancelled) setResults([]);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
      return () => {
        cancelled = true;
      };
    }, 200);

    return () => clearTimeout(timer);
  }, [query]);

  // Clicking away closes the list without choosing anything.
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  function pick(m: Medicine) {
    onChange(m);
    setQuery('');
    setResults(null);
    setOpen(false);
  }

  // Chosen state: show what was picked, with a way back to searching. A picker
  // that keeps the raw query visible after selection leaves the pharmacist
  // unsure whether the thing they typed actually took.
  if (value) {
    return (
      <div className="flex items-center justify-between rounded-md border border-border bg-bg px-3 py-2">
        <span className="text-sm">
          <span className="font-medium text-text">{value.name}</span>{' '}
          <span className="font-mono text-xs text-text-muted">{value.strength}</span>{' '}
          <span className="text-xs text-text-subtle">{value.form}</span>
        </span>
        <button
          type="button"
          onClick={() => onChange(null)}
          className="text-xs text-primary hover:underline"
        >
          Change
        </button>
      </div>
    );
  }

  const showList = open && query.trim().length >= 2;

  return (
    <div ref={boxRef} className="relative">
      <Input
        value={query}
        autoFocus={autoFocus}
        placeholder="Start typing a name…"
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (!results || results.length === 0) return;
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setHighlight((h) => Math.min(h + 1, results.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setHighlight((h) => Math.max(h - 1, 0));
          } else if (e.key === 'Enter') {
            // Prevented, or Enter submits the sheet with nothing chosen.
            e.preventDefault();
            pick(results[highlight]);
          } else if (e.key === 'Escape') {
            setOpen(false);
          }
        }}
      />

      {showList && (
        <div className="absolute z-20 mt-1 max-h-56 w-full overflow-y-auto rounded-md border border-border bg-surface shadow-lg">
          {results === null ? (
            <p className="px-3 py-2 text-xs text-text-subtle">
              {searching ? 'Searching…' : ' '}
            </p>
          ) : results.length === 0 ? (
            /*
             * Points at the fix rather than just reporting nothing. An empty
             * catalogue is the single most common reason a new hospital's
             * pharmacy appears broken, and this box is where somebody first
             * meets it.
             */
            <p className="px-3 py-2 text-xs text-text-subtle">
              Nothing matches &ldquo;{query.trim()}&rdquo;. Stock has to attach to a catalogue
              entry — add the medicine first, using <strong>Add medicine</strong>.
            </p>
          ) : (
            results.map((m, i) => (
              <button
                key={m.id}
                type="button"
                onMouseEnter={() => setHighlight(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(m)}
                className={`flex w-full items-baseline justify-between border-b border-[#f0f2f4] px-3 py-1.5 text-left text-sm last:border-b-0 ${
                  i === highlight ? 'bg-primary-soft' : 'hover:bg-primary-soft'
                }`}
              >
                <span>
                  <span className="font-medium">{m.name}</span>{' '}
                  <span className="font-mono text-xs text-text-muted">{m.strength}</span>
                </span>
                <span className="text-xxs text-text-subtle">{m.form}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
