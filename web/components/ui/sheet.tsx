'use client';

import { useEffect } from 'react';

/**
 * Side sheet, not a modal dialog.
 *
 * Clinical forms need room, and the patient header has to stay visible while
 * the clinician fills them in — prescribing against the wrong record is the
 * mistake this layout exists to prevent.
 */
export function Sheet({
  open,
  onClose,
  title,
  footer,
  children,
  width = 'w-[420px]',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  footer?: React.ReactNode;
  children: React.ReactNode;
  width?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-black/20" onClick={onClose} aria-hidden />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`relative z-10 flex h-full flex-col border-l border-border-strong bg-surface shadow-2xl ${width}`}
      >
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-md font-semibold">{title}</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-sm px-2 text-lg leading-none text-text-subtle hover:bg-bg"
          >
            ×
          </button>
        </header>
        <div className="scroll-thin flex-1 overflow-y-auto px-4 py-3.5">{children}</div>
        {footer && (
          <footer className="flex items-center gap-2 border-t border-border bg-bg px-4 py-3">
            {footer}
          </footer>
        )}
      </aside>
    </div>
  );
}
