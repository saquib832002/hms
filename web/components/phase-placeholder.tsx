import { EmptyState } from '@/components/ui/primitives';

/**
 * Roles whose screens land in later phases still need somewhere to go. A
 * placeholder that names the phase and what it is waiting on beats a 404 —
 * and beats a half-built screen backed by models that do not exist yet.
 */
export function PhasePlaceholder({
  title,
  phase,
  blockedOn,
}: {
  title: string;
  phase: number;
  blockedOn: string;
}) {
  return (
    <div className="flex flex-1 items-center justify-center">
      <EmptyState
        title={`${title} — Phase ${phase}`}
        description={`Not built yet. Blocked on: ${blockedOn}. See PLAN.md for the phasing.`}
      />
    </div>
  );
}
