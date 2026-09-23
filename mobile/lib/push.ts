import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
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
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

let currentToken: string | null = null;

export async function registerForPush(): Promise<string | null> {
  // Simulators cannot receive push. Failing softly here keeps the app usable
  // in development rather than blocking sign-in.
  if (!Device.isDevice) return null;

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
  const token = (await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined))
    .data;

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
