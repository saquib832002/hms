import * as Device from 'expo-device';
import Constants, { ExecutionEnvironment } from 'expo-constants';
import { Platform } from 'react-native';
import { api } from './api';

/**
 * Push registration.
 *
 * The notification *content* is decided entirely by the server, and by design
 * contains no patient data — see backend/src/notifications/notification-payload.ts.
 * The app's job is to hand over a token and, when tapped, deep-link to a screen
 * that fetches the detail over the authenticated API. That fetch is audited;
 * a glance at a lock screen is not.
 */

/**
 * `expo-notifications` is loaded on demand, and **nothing may import it at the
 * top level** — not this file, not a screen.
 *
 * In Expo Go on Android the module **throws when it is imported**, not when it
 * is called: remote push was removed from Expo Go in SDK 53 and from SDK 55 the
 * module raises rather than warning. Expo Router statically requires every file
 * under `app/`, so a top-level import in one screen takes down the *whole app*
 * at `ExpoRoot` render — which is exactly what was reported, a red screen at
 * launch naming `ExpoRoot.js` and no screen of ours.
 *
 * A guard inside `registerForPush` was not enough for the same reason: by the
 * time any of our code runs, the import has already thrown. So the import has
 * to be dynamic, and it is centralised here rather than repeated per call site,
 * because the dangerous version of this is one screen adding the top-level
 * import back and the failure landing nowhere near it.
 *
 * Returns `null` when push is unavailable, which every caller treats as
 * ordinary: a release build gets the module, Expo Go gets a warning and a
 * working app without alerts.
 */
type NotificationsModule = typeof import('expo-notifications');

let cached: NotificationsModule | null | undefined;

export async function loadNotifications(): Promise<NotificationsModule | null> {
  if (cached !== undefined) return cached;

  if (Constants.executionEnvironment === ExecutionEnvironment.StoreClient) {
    console.warn(
      '[push] Expo Go cannot receive push notifications on Android. ' +
        'The app works; alerts do not. Use a development build to test them.',
    );
    cached = null;
    return null;
  }

  try {
    const mod = await import('expo-notifications');
    /*
     * The handler is set here rather than at module scope, because module scope
     * is the thing that cannot be reached safely. Once, on first successful
     * load — `setNotificationHandler` replaces rather than accumulates, so a
     * second call is harmless, but calling it per screen mount would make the
     * live handler depend on mount order.
     */
    mod.setNotificationHandler({ handleNotification: async () => PRESENTATION });
    cached = mod;
    return mod;
  } catch (err) {
    console.warn('[push] expo-notifications is unavailable — alerts will not arrive:', err);
    cached = null;
    return null;
  }
}

/*
 * `shouldShowAlert` was one switch and is now two, as of expo-notifications
 * 0.31 (SDK 53). The split is real rather than cosmetic: `shouldShowBanner` is
 * the heads-up card that appears over whatever is on screen, and
 * `shouldShowList` is whether it stays in the notification tray afterwards.
 *
 * Both are true here deliberately. A banner without a list entry is a message
 * that vanishes if somebody is looking at a patient when it arrives — and the
 * things this app notifies about are a critical value, a ward request and a
 * partner's report, none of which should depend on being seen the instant they
 * land. A list entry without a banner is the opposite failure and just as bad.
 *
 * The old field is dropped rather than left beside the new ones: it is
 * deprecated, and two switches that claim to control the same thing are how
 * somebody later changes the one that no longer does anything.
 */
const PRESENTATION = {
  shouldShowBanner: true,
  shouldShowList: true,
  shouldPlaySound: true,
  shouldSetBadge: true,
} as const;

let currentToken: string | null = null;

export async function registerForPush(): Promise<string | null> {
  // Simulators cannot receive push. Failing softly here keeps the app usable
  // in development rather than blocking sign-in.
  if (!Device.isDevice) return null;

  // Absent in Expo Go and wherever the native module will not load — see
  // `loadNotifications`. Never throws; returns null and says why.
  const Notifications = await loadNotifications();
  if (!Notifications) return null;

  const existing = await Notifications.getPermissionsAsync();
  let status = existing.status;
  if (status !== 'granted') {
    status = (await Notifications.requestPermissionsAsync()).status;
  }
  if (status !== 'granted') return null;

  if (Platform.OS === 'android') {
    // One channel per notification kind so repeats collapse instead of
    // stacking into a wall of banners a doctor has to dismiss individually.
    for (const kind of ['PATIENT_CHECKED_IN', 'QUEUE_WAITING', 'PRESCRIPTION_QUERY', 'CRITICAL_RESULT']) {
      await Notifications.setNotificationChannelAsync(kind, {
        name: kind,
        importance: Notifications.AndroidImportance.HIGH,
        // Even the private version carries no PHI, but marking it private
        // means the OS respects "hide sensitive content" settings too.
        lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
      });
    }
  }

  const projectId = Constants.expoConfig?.extra?.eas?.projectId as string | undefined;

  /*
   * The token call is the one thing here that can throw for reasons outside
   * this app's control — no Google Services on the handset, a device with no
   * Play Services at all, FCM unreachable, a misconfigured project id.
   *
   * None of those should stop a doctor signing in. The function already returns
   * `null` for "no push available" and every caller treats that as ordinary, so
   * the failure joins that path rather than propagating: the alternative is what
   * was just reported — an unhandled rejection on a screen the user cannot act
   * on, naming a module instead of a cause.
   *
   * Logged rather than swallowed. "Alerts silently never arrive" is a bad
   * failure to make invisible, and this line is the only place it is knowable.
   */
  let token: string;
  try {
    token = (await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined)).data;
  } catch (err) {
    console.warn('[push] could not obtain a push token — alerts will not arrive:', err);
    return null;
  }

  currentToken = token;
  await api('/devices', {
    method: 'POST',
    body: { pushToken: token, platform: Platform.OS },
  }).catch(() => {
    // Not fatal — the doctor can still use the app, they just will not be
    // alerted. Blocking sign-in over this would be the wrong trade.
  });

  return token;
}

export async function unregisterPush(): Promise<void> {
  currentToken = null;
}

export function getPushToken(): string | null {
  return currentToken;
}
