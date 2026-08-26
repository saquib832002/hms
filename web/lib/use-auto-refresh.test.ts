import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { relativeAge, useAutoRefresh } from './use-auto-refresh';

describe('relativeAge', () => {
  const now = new Date('2026-08-12T10:00:00Z');

  it('handles a null timestamp', () => {
    expect(relativeAge(null, now)).toBe('—');
  });

  it.each([
    [5, 'just now'],
    [30, '30s ago'],
    [120, '2 min ago'],
    [3600, '1h ago'],
  ])('renders %ss ago as "%s"', (seconds, expected) => {
    expect(relativeAge(new Date(now.getTime() - seconds * 1000), now)).toBe(expected);
  });

  it('never renders a negative age from small clock skew', () => {
    expect(relativeAge(new Date(now.getTime() + 3000), now)).toBe('just now');
  });
});

describe('useAutoRefresh', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('polls on the interval', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    renderHook(() => useAutoRefresh(refresh, { intervalMs: 1000 }));

    expect(refresh).not.toHaveBeenCalled(); // the caller owns the initial load

    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it('stops polling when disabled', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const { rerender } = renderHook(
      ({ enabled }) => useAutoRefresh(refresh, { intervalMs: 1000, enabled }),
      { initialProps: { enabled: true } },
    );

    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(refresh).toHaveBeenCalledTimes(2);

    // Sheets disable polling so the screen cannot shift under a half-written
    // prescription.
    rerender({ enabled: false });
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('does not restart the interval when the callback identity changes', async () => {
    // Pages recreate `load` on most renders. If that reset the timer, a busy
    // screen would never actually poll.
    const refresh = vi.fn().mockResolvedValue(undefined);
    const { rerender } = renderHook(() => useAutoRefresh(refresh, { intervalMs: 1000 }));

    await act(async () => {
      vi.advanceTimersByTime(900);
    });
    rerender();
    await act(async () => {
      vi.advanceTimersByTime(200);
    });

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('records when the data was last refreshed', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useAutoRefresh(refresh, { intervalMs: 1000 }));

    expect(result.current.lastUpdated).toBeNull();
    await act(async () => {
      await result.current.refreshNow();
    });
    expect(result.current.lastUpdated).toBeInstanceOf(Date);
  });

  it('stops polling while the tab is hidden', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    renderHook(() => useAutoRefresh(refresh, { intervalMs: 1000 }));

    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(refresh).toHaveBeenCalledTimes(1);

    // A screen left open overnight on a ward terminal should not spend the
    // night querying.
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      vi.advanceTimersByTime(5000);
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('refreshes immediately when the tab becomes visible again', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    renderHook(() => useAutoRefresh(refresh, { intervalMs: 60_000 }));

    const spy = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    spy.mockReturnValue('visible');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    // Returning to a tab must not show stale data while waiting for the tick.
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('clears its interval on unmount', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const { unmount } = renderHook(() => useAutoRefresh(refresh, { intervalMs: 1000 }));

    unmount();
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(refresh).not.toHaveBeenCalled();
  });
});
