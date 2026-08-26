'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import type { PatientListItem, Paginated } from '@/lib/types';
import { date } from '@/lib/format';

/**
 * ⌘K global patient search.
 *
 * The single highest-value component in the product — doctors and
 * receptionists look a patient up dozens of times a day, and every other path
 * to a patient is slower than typing three letters of their name.
 */
export function useCommandPalette() {
  const [isOpen, setIsOpen] = useState(false);
  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setIsOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return { isOpen, open, close };
}

export function CommandPalette({ isOpen, close }: { isOpen: boolean; close: () => void }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PatientListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setResults([]);
      setCursor(0);
      // Focus after paint, or the input isn't mounted yet.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [isOpen]);

  // Debounced. Patient search is rate-limited harder than other reads on the
  // server — firing a request per keystroke would trip it during normal typing.
  useEffect(() => {
    if (!isOpen) return;
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(() => {
      api<Paginated<PatientListItem>>(`/patients?q=${encodeURIComponent(q)}&limit=8`)
        .then((res) => !cancelled && setResults(res.data))
        .catch(() => !cancelled && setResults([]))
        .finally(() => !cancelled && setLoading(false));
    }, 220);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, isOpen]);

  const go = useCallback(
    (id: number) => {
      close();
      router.push(`/patients?id=${id}`);
    },
    [close, router],
  );

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh]">
      <div className="absolute inset-0 bg-black/25" onClick={close} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search patients"
        className="relative z-10 w-[540px] overflow-hidden rounded border border-border-strong bg-surface shadow-2xl"
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setCursor(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') close();
            if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) {
              e.preventDefault();
              setCursor((c) => Math.min(c + 1, results.length - 1));
            }
            if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) {
              e.preventDefault();
              setCursor((c) => Math.max(c - 1, 0));
            }
            if (e.key === 'Enter' && results[cursor]) go(results[cursor].id);
          }}
          placeholder="Search by name, phone or patient ID…"
          className="w-full border-b border-border px-4 py-3 text-md outline-none placeholder:text-text-subtle"
        />

        <div className="max-h-[320px] overflow-y-auto">
          {query.trim().length < 2 && (
            <p className="px-4 py-6 text-center text-sm text-text-subtle">
              Type at least two characters
            </p>
          )}
          {query.trim().length >= 2 && loading && results.length === 0 && (
            <p className="px-4 py-6 text-center text-sm text-text-subtle">Searching…</p>
          )}
          {query.trim().length >= 2 && !loading && results.length === 0 && (
            <p className="px-4 py-6 text-center text-sm text-text-subtle">No patients found</p>
          )}

          {results.map((p, i) => (
            <button
              key={p.id}
              onMouseEnter={() => setCursor(i)}
              onClick={() => go(p.id)}
              className={`flex w-full items-center gap-3 px-4 py-2 text-left text-sm ${
                i === cursor ? 'bg-primary-soft' : 'hover:bg-bg'
              }`}
            >
              <span className="flex-1 truncate font-medium">
                {p.fullName}
                {p.hasAllergies && (
                  <span
                    title="Has recorded allergies"
                    className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-danger align-middle"
                  />
                )}
              </span>
              <span className="font-mono text-xs text-text-muted">{date(p.dob)}</span>
              <span className="font-mono text-xs text-text-subtle">#{p.id}</span>
            </button>
          ))}
        </div>

        <div className="flex gap-3 border-t border-border bg-bg px-4 py-1.5 text-xxs text-text-subtle">
          <span>↑↓ navigate</span>
          <span>⏎ open</span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  );
}
