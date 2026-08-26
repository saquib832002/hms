import type { AppointmentStatus } from '@/lib/types';
import { cx } from './primitives';

/**
 * Status is never conveyed by colour alone — every chip carries its label.
 * Roughly 1 in 12 men has some colour vision deficiency, and hospital staff
 * are not exempt.
 */
const STYLES: Record<AppointmentStatus, string> = {
  SCHEDULED: 'bg-primary-soft text-primary',
  CHECKED_IN: 'bg-warning-soft text-warning',
  IN_PROGRESS: 'bg-danger-soft text-danger',
  COMPLETED: 'bg-success-soft text-success',
  CANCELLED: 'bg-[#eef0f2] text-text-muted',
  NO_SHOW: 'bg-[#eef0f2] text-text-muted',
};

const LABELS: Record<AppointmentStatus, string> = {
  SCHEDULED: 'Scheduled',
  CHECKED_IN: 'Checked in',
  IN_PROGRESS: 'In progress',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
  NO_SHOW: 'No-show',
};

export function StatusChip({ status }: { status: AppointmentStatus }) {
  return (
    <span
      className={cx(
        'inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-xxs font-semibold tracking-wide',
        STYLES[status],
      )}
    >
      {LABELS[status]}
    </span>
  );
}
