'use client';

import { useCallback } from 'react';
import { useAuth } from './auth-context';
import { money } from './format';

/**
 * Formats money in the signed-in hospital's currency.
 *
 * A hook rather than a module-level setting, because the currency belongs to
 * the session and not to the process. Stashing it in a module variable would
 * work in this app and break the moment two hospitals are rendered by one
 * server — which is exactly the failure multi-tenancy exists to prevent, so it
 * is not a shortcut worth taking here.
 *
 * Falls back to GBP only when there is no session, which in practice means a
 * component rendering before login resolves.
 */
export function useMoney(): (amount: string) => string {
  const { user } = useAuth();
  const currency = user?.hospital?.currency ?? 'GBP';
  return useCallback((amount: string) => money(amount, currency), [currency]);
}
