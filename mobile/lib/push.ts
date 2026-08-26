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

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
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
