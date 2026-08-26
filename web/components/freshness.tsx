'use client';

import { useEffect, useState } from 'react';
import { relativeAge } from '@/lib/use-auto-refresh';
import { Button } from './ui/primitives';

/**
 * Shows how old the data on screen is, and lets the user force a refresh.
 *
 * An auto-refreshing screen that gives no sign of when it last succeeded is
 * worse than a static one: staff assume it is current. If the network drops,
 * the queue simply stops changing and looks like a quiet morning.
 */
export function Freshness({
  lastUpdated,
  refreshing,
  onRefresh,
}: {
  lastUpdated: Date | null;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  // Re-render on a timer so "12s ago" keeps counting between fetches.
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 5000);
    return () => clearInterval(t);
  }, []);

  const stale = lastUpdated ? Date.now() - lastUpdated.getTime() > 60_000 : false;

  return (
    <div className="flex items-center gap-1.5">
      <span
        className={`text-xxs ${stale ? 'font-semibold text-warning' : 'text-text-subtle'}`}
        title={lastUpdated ? lastUpdated.toLocaleTimeString() : undefined}
      >
        {refreshing ? 'Updating…' : `Updated ${relativeAge(lastUpdated)}`}
      </span>
      <Button size="sm" variant="ghost" onClick={onRefresh} disabled={refreshing} aria-label="Refresh now">
        ↻
      </Button>
    </div>
  );
}
