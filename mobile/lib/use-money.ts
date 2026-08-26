import { useCallback } from 'react';
import { useAuth } from './auth-context';
import { money } from './format';

/**
 * Formats money in the signed-in hospital's currency.
 *
 * Same reasoning as the web hook: the currency belongs to the session, not the
 * process, so it is read from the authenticated user rather than a module
 * constant.
 */
export function useMoney(): (amount: string) => string {
  const { user } = useAuth();
  const currency = user?.hospital?.currency ?? 'GBP';
  return useCallback((amount: string) => money(amount, currency), [currency]);
}
