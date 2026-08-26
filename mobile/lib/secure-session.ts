/**
 * Where the mobile app keeps its credentials.
 *
 * Access token: memory only, same as web.
 *
 * Refresh token: `expo-secure-store`, which is the iOS Keychain and Android
 * EncryptedSharedPreferences. NOT `AsyncStorage` — AsyncStorage is a plain
 * SQLite file in the app sandbox, readable in seconds on a rooted or
 * jailbroken device and included in unencrypted device backups. A refresh
 * token lifted from there is a seven-day session against patient records.
 *
 * The storage layer is injected so the session logic can be tested in Node
 * without a device. `expo-secure-store` cannot be imported outside a native
 * runtime, and mocking a module that deep tends to test the mock.
 */

export interface SecureStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  deleteItem(key: string): Promise<void>;
}

const REFRESH_KEY = 'hms.refresh';

export class SecureSession {
  private accessToken: string | null = null;

  constructor(private storage: SecureStorage) {}

  getAccessToken(): string | null {
    return this.accessToken;
  }

  setAccessToken(token: string | null): void {
    this.accessToken = token;
  }

  getRefreshToken(): Promise<string | null> {
    return this.storage.getItem(REFRESH_KEY);
  }

  async setRefreshToken(token: string): Promise<void> {
    await this.storage.setItem(REFRESH_KEY, token);
  }

  /**
   * Wipes both tokens. Called on sign-out, on a rejected refresh, and when
   * the idle timer expires — anything that ends the session must leave
   * nothing behind for the next person to pick up the phone.
   */
  async clear(): Promise<void> {
    this.accessToken = null;
    await this.storage.deleteItem(REFRESH_KEY);
  }
}

/**
 * A phone left on a ward desk is a breach waiting to happen — and unlike a
 * workstation, it is small enough to be picked up and carried off.
 *
 * After 15 idle minutes the app locks. The refresh token is kept, so unlocking
 * is a biometric prompt rather than typing a password on a phone keyboard
 * mid-round; the point is that the screen behind it is not readable by whoever
 * is holding the device.
 */
export const IDLE_LOCK_MS = 15 * 60 * 1000;

export function isIdleExpired(lastActivity: number, now: number = Date.now()): boolean {
  return now - lastActivity >= IDLE_LOCK_MS;
}
