'use client';

import { forwardRef } from 'react';

export function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(' ');
}

// ── Button ────────────────────────────────────────────────────────────────
type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'danger' | 'ghost';
  size?: 'sm' | 'md';
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'default', size = 'md', className, ...props },
  ref,
) {
  const variants = {
    default: 'bg-surface border-border-strong text-text hover:bg-[#f2f4f6]',
    primary: 'bg-primary border-primary text-white hover:bg-primary-hover',
    danger: 'bg-surface border-border-strong text-danger hover:bg-danger-soft',
    ghost: 'bg-transparent border-transparent text-text-muted hover:bg-[#f2f4f6]',
  };
  return (
    <button
      ref={ref}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-sm border font-medium transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3 py-1.5 text-sm',
        variants[variant],
        className,
      )}
      {...props}
    />
  );
});

// ── Inputs ────────────────────────────────────────────────────────────────
const fieldBase =
  'w-full rounded-sm border border-border-strong bg-surface px-2.5 py-1.5 text-base ' +
  'text-text placeholder:text-text-subtle focus:border-primary disabled:bg-bg';

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return <input ref={ref} className={cx(fieldBase, className)} {...props} />;
  },
);

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, ...props }, ref) {
  return <textarea ref={ref} className={cx(fieldBase, 'resize-y', className)} {...props} />;
});

export const Select = forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, ...props }, ref) {
    return <select ref={ref} className={cx(fieldBase, className)} {...props} />;
  },
);

export function Field({
  label,
  required,
  hint,
  error,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="mb-3 block">
      <span className="mb-1 block text-xs font-semibold text-text-muted">
        {label}
        {required && <span className="ml-0.5 text-danger">*</span>}
      </span>
      {children}
      {hint && !error && <span className="mt-1 block text-xs text-text-subtle">{hint}</span>}
      {error && <span className="mt-1 block text-xs text-danger">{error}</span>}
    </label>
  );
}

// ── Layout bits ───────────────────────────────────────────────────────────
export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cx('rounded border border-border bg-surface p-3.5', className)} {...props} />;
}

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-2 mt-4 border-b border-border pb-1 text-xxs font-semibold uppercase tracking-wider text-text-subtle first:mt-0">
      {children}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('animate-pulse rounded-sm bg-border', className)} />;
}

/** Skeleton rows, not a centred spinner — the layout must not jump. */
export function TableSkeleton({ rows = 8, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div className="p-3">
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex gap-3 border-b border-[#f0f2f4] py-2.5">
          {Array.from({ length: cols }).map((_, c) => (
            <Skeleton key={c} className={cx('h-3.5', c === 1 ? 'flex-[2]' : 'flex-1')} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      <div className="text-md font-semibold text-text">{title}</div>
      {description && <p className="mt-1 max-w-sm text-sm text-text-muted">{description}</p>}
      {action && <div className="mt-3.5">{action}</div>}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      <div className="text-md font-semibold text-danger">Something went wrong</div>
      <p className="mt-1 max-w-md text-sm text-text-muted">{message}</p>
      {onRetry && (
        <Button className="mt-3.5" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}
