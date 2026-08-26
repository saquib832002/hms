'use client';

import { useEffect, useRef } from 'react';
import { Button } from './primitives';

/**
 * Confirmation for actions that cannot be undone.
 *
 * Two rules from docs/ui-design.md, both about the same thing — the user
 * should know what they are about to cause:
 *
 *  - the button says what will happen ("Cancel appointment"), never "OK"
 *  - the body states the consequence, not the mechanics
 *
 * Deliberately NOT used for routine reversible actions. Checking a patient in
 * forty times a morning must stay one click; a dialog there would train
 * everyone to dismiss dialogs without reading them, which is how the ones
 * that matter stop working.
 */
export function ConfirmDialog({
  open,
  title,
  consequence,
  confirmLabel,
  destructive = true,
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  consequence: string;
  confirmLabel: string;
  destructive?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    // Focus lands on Cancel, not Confirm. A stray Enter keypress from the
    // action that opened this must not confirm it.
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
      <div className="absolute inset-0 bg-black/25" onClick={onCancel} aria-hidden />
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-consequence"
        className="relative z-10 w-full max-w-[400px] rounded border border-border-strong bg-surface p-4 shadow-2xl"
      >
        <h2 id="confirm-title" className="text-md font-semibold">
          {title}
        </h2>
        <p id="confirm-consequence" className="mt-1.5 text-sm text-text-muted">
          {consequence}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button ref={cancelRef} onClick={onCancel} disabled={busy}>
            Keep it
          </Button>
          <Button variant={destructive ? 'danger' : 'primary'} onClick={onConfirm} disabled={busy}>
            {busy ? 'Working…' : confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
