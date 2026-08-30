import { useCallback } from 'react';
import { AppState } from 'react-native';
import { useFocusEffect } from 'expo-router';

/**
 * Keeps a screen's data current: on focus, and on a timer while focused.
 *
 * WHY EVERY LIST NEEDED THIS
 * --------------------------
 * Every screen loaded once in `useEffect` and then never again. Expo Router
 * keeps a route mounted while you push another on top of it, so returning from
 * reschedule or booking showed the list exactly as it was before the change —
 * the receptionist had just moved an appointment and the row still read the old
 * time. Nothing was wrong with the write; the screen simply never asked again.
 *
 * That is worse than stale data on a dashboard. A hospital schedule is shared:
 * a second receptionist checks someone in, a doctor completes a consultation,
 * and a screen that never re-reads is quietly telling one member of staff
 * something the rest of the building knows to be false.
 *
 * `useFocusEffect` rather than `useEffect`: focus fires on first mount *and*
 * every time the screen comes back to the front, which is the case the plain
 * effect missed.
 *
 * THE POLL PAUSES WITH THE APP
 * ----------------------------
 * `AppState.currentState` is checked on each tick rather than only at setup.
 * A phone in a pocket should not be waking to fetch patient lists — that is
 * battery, and it is PHI being pulled onto a device nobody is looking at.
 *
 * Re-running when `load` changes identity is deliberate: screens build `load`
 * with `useCallback` keyed on what they are showing — the selected date, the
 * chosen ward — so a change there refetches immediately instead of waiting for
 * the next tick.
 */
export const LIVE_REFRESH_MS = 15_000;

export function useLiveData(load: () => void | Promise<void>, intervalMs = LIVE_REFRESH_MS) {
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;

      const run = () => {
        if (cancelled) return;
        if (AppState.currentState !== 'active') return;
        void load();
      };

      run();
      const timer = setInterval(run, intervalMs);

      return () => {
        cancelled = true;
        clearInterval(timer);
      };
    }, [load, intervalMs]),
  );
}
