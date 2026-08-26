import fs from 'node:fs';
import path from 'node:path';
import { IDLE_LOCK_MS, isIdleExpired, SecureSession, SecureStorage } from './secure-session';

function fakeStorage(): SecureStorage & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    getItem: async (k) => store.get(k) ?? null,
    setItem: async (k, v) => void store.set(k, v),
    deleteItem: async (k) => void store.delete(k),
  };
}

describe('SecureSession', () => {
  it('keeps the access token in memory, never in storage', async () => {
    // The whole point: a refresh token in the Keychain is defensible, an
    // access token written to disk alongside it is not, and neither belongs
    // in AsyncStorage.
    const storage = fakeStorage();
    const session = new SecureSession(storage);

    session.setAccessToken('access-abc');

    expect(session.getAccessToken()).toBe('access-abc');
    expect([...storage.store.values()]).not.toContain('access-abc');
    expect(storage.store.size).toBe(0);
  });

  it('persists the refresh token through the injected secure storage', async () => {
    const storage = fakeStorage();
    const session = new SecureSession(storage);

    await session.setRefreshToken('refresh-xyz');

    expect(await session.getRefreshToken()).toBe('refresh-xyz');
  });

  it('returns null when there is no stored session', async () => {
    expect(await new SecureSession(fakeStorage()).getRefreshToken()).toBeNull();
  });

  it('clear() removes both tokens', async () => {
    // Sign-out, a rejected refresh and the idle lock all route through this.
    // Anything left behind is available to whoever picks the phone up next.
    const storage = fakeStorage();
    const session = new SecureSession(storage);
    session.setAccessToken('access-abc');
    await session.setRefreshToken('refresh-xyz');

    await session.clear();

    expect(session.getAccessToken()).toBeNull();
    expect(await session.getRefreshToken()).toBeNull();
    expect(storage.store.size).toBe(0);
  });

  it('overwrites rather than accumulating rotated refresh tokens', async () => {
    const storage = fakeStorage();
    const session = new SecureSession(storage);

    await session.setRefreshToken('first');
    await session.setRefreshToken('second');

    expect(storage.store.size).toBe(1);
    expect(await session.getRefreshToken()).toBe('second');
  });
});

describe('idle lock', () => {
  it('locks after 15 minutes', () => {
    expect(IDLE_LOCK_MS).toBe(15 * 60 * 1000);
  });

  it('does not lock inside the window', () => {
    const now = Date.now();
    expect(isIdleExpired(now - 60_000, now)).toBe(false);
    expect(isIdleExpired(now - (IDLE_LOCK_MS - 1000), now)).toBe(false);
  });

  it('locks exactly at the boundary and beyond', () => {
    const now = Date.now();
    expect(isIdleExpired(now - IDLE_LOCK_MS, now)).toBe(true);
    expect(isIdleExpired(now - 60 * 60 * 1000, now)).toBe(true);
  });

  it('does not unlock itself if the device clock jumps backwards', () => {
    // A phone that picks up a bad NTP time must not be able to skip the lock.
    const now = Date.now();
    expect(isIdleExpired(now + 60_000, now)).toBe(false);
  });
});

describe('storage discipline', () => {
  it('never reaches for AsyncStorage', () => {
    const root = path.resolve(__dirname, '..');

    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir)) {
        if (entry === 'node_modules' || entry === '.expo') continue;
        const full = path.join(dir, entry);
        if (fs.statSync(full).isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry) && !/\.test\.ts$/.test(entry)) files.push(full);
      }
    };
    walk(root);

    const stripComments = (src: string) =>
      src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

    const offenders = files
      .filter((f) => stripComments(fs.readFileSync(f, 'utf8')).includes('AsyncStorage'))
      .map((f) => path.relative(root, f));

    // AsyncStorage is an unencrypted SQLite file in the app sandbox, readable
    // on a rooted device and captured in unencrypted backups.
    expect(offenders).toEqual([]);
  });
});
