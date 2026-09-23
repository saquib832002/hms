/**
 * Expo config, resolved per environment.
 *
 * Replaces the static `app.json`, which could only describe one deployment. A
 * release build has no Expo dev server to derive the API host from, so the
 * origin has to be baked in at build time — and hard-coding it meant editing a
 * committed file before every production build and remembering to change it
 * back. That is the shape of mistake that ships a clinic an app pointing at a
 * laptop.
 *
 *   APP_ENV=development   (default) — LAN dev server, API host auto-detected
 *   APP_ENV=staging       — a named staging origin
 *   APP_ENV=production    — the real hospital
 *
 * Usage:
 *   npx expo start                              # development
 *   APP_ENV=production eas build -p android     # production
 *   APP_ENV=production API_ORIGIN=https://x eas build -p android
 *
 * WHY EACH ENVIRONMENT GETS ITS OWN PACKAGE ID
 * --------------------------------------------
 * So a staging build and the real one can sit on the same phone at once, with
 * different names and icons. Without that, testing a release candidate means
 * uninstalling the app a nurse is using — and the two are indistinguishable on
 * the home screen, which is how somebody records vitals into the wrong
 * database.
 */

const ENV = process.env.APP_ENV ?? 'development';

/**
 * Per-environment settings.
 *
 * `apiOrigin` is `null` in development on purpose. `lib/api.ts` derives the
 * host from the Expo dev server, which is what makes the app work on a LAN
 * with no configuration — pinning a value here would break that for everyone
 * whose laptop IP is not the one committed.
 */
const ENVIRONMENTS = {
  development: {
    name: 'My Hospital (dev)',
    packageId: 'com.sawera.myhospital.dev',
    apiOrigin: null,
    scheme: 'meridianhms-dev',
    iconSuffix: '-development',
  },
  staging: {
    name: 'My Hospital (staging)',
    packageId: 'com.sawera.myhospital.staging',
    apiOrigin: process.env.API_ORIGIN ?? 'https://staging.example.com',
    scheme: 'meridianhms-staging',
    iconSuffix: '-staging',
  },
  production: {
    name: 'My Hospital',
    packageId: 'com.sawera.myhospital',
    apiOrigin: process.env.API_ORIGIN ?? 'https://hms.sawera.info',
    scheme: 'meridianhms',
    iconSuffix: '',
  },
};

/**
 * The field the mark sits on, and the red it is drawn in.
 *
 * Duplicated from `scripts/make-icons.mjs` rather than imported, because this
 * file is evaluated by Expo's config loader and must not reach into a build
 * script. What matters is that `BRAND_FIELD` equals the field colour the icons
 * were generated with: Android composites the adaptive foreground over this
 * value, and the heartbeat through the cross is a *cut* in the field colour, so
 * the two disagreeing does not produce a wrong shade — it produces a visible
 * line across the icon on every Android home screen.
 */
const BRAND_FIELD = '#0D1317';
const BRAND_RED = '#E8262D';

const config = ENVIRONMENTS[ENV];

if (!config) {
  // Loud, not a silent fallback to development. An unrecognised APP_ENV that
  // quietly built a dev app and shipped it is worse than a failed build.
  throw new Error(
    `Unknown APP_ENV "${ENV}". Expected one of: ${Object.keys(ENVIRONMENTS).join(', ')}`,
  );
}

/*
 * A release build talking to plain HTTP is refused rather than shipped.
 *
 * Android blocks cleartext by default, so it would fail on a device anyway —
 * but as a confusing "network request failed" rather than anything naming the
 * cause. More to the point, the refresh token is a `Secure` cookie and patient
 * data would be crossing the wire in the clear.
 */
if (ENV !== 'development' && config.apiOrigin && !config.apiOrigin.startsWith('https://')) {
  throw new Error(
    `API_ORIGIN for ${ENV} must be https — got "${config.apiOrigin}".\n` +
      'Android blocks cleartext traffic, and this app carries patient data.',
  );
}

module.exports = {
  expo: {
    name: config.name,
    slug: 'hms-mobile',
    version: '0.1.0',
    orientation: 'portrait',
    scheme: config.scheme,
    userInterfaceStyle: 'light',
    newArchEnabled: true,

    /*
     * Square, full-bleed, no transparency. Both stores mask the corners
     * themselves, so artwork that arrives pre-rounded is rounded twice and
     * shows a dark crescent inside the mask.
     */
    icon: `./assets/icon${config.iconSuffix}.png`,

    /*
     * The mark is a third of the canvas rather than the whole of it, because
     * `contain` fits this image to the screen's width. The background is the
     * same colour as the image's own field, so the letterboxing does not show
     * as a band above and below the artwork.
     */
    splash: {
      image: `./assets/splash${config.iconSuffix}.png`,
      resizeMode: 'contain',
      backgroundColor: BRAND_FIELD,
    },

    ios: {
      supportsTablet: false,
      bundleIdentifier: config.packageId,
      infoPlist: {
        NSFaceIDUsageDescription: 'Unlock My Hospital to view patient information.',
      },
    },

    android: {
      package: config.packageId,
      permissions: ['USE_BIOMETRIC', 'USE_FINGERPRINT'],
      /*
       * `backgroundColor` must equal the field the foreground was drawn
       * against. The heartbeat through the cross is a cut in that colour, not a
       * line painted over it, so a mismatch here does not tint the icon — it
       * draws a stripe across it.
       */
      adaptiveIcon: {
        foregroundImage: `./assets/adaptive-icon${config.iconSuffix}.png`,
        backgroundColor: BRAND_FIELD,
      },
    },

    plugins: [
      'expo-router',
      'expo-secure-store',
      'expo-local-authentication',
      'expo-asset',
      'expo-font',

      /*
       * `expo-notifications` was a dependency and not a plugin, which is not a
       * tidiness point: the plugin is the thing that copies the notification
       * icon into `res/drawable` and writes the default colour into the
       * manifest. Without it the asset is never bundled and Android falls back
       * to a grey square, whatever the config says.
       *
       * Android discards colour in this image and tints the silhouette, so it
       * is a white cross on transparent — see `scripts/make-icons.mjs`.
       */
      [
        'expo-notifications',
        {
          icon: './assets/notification-icon.png',
          color: BRAND_RED,
        },
      ],
    ],

    extra: {
      /**
       * `eas.projectId` has to be pasted in here by hand.
       *
       * `eas init` writes it into a static `app.json` automatically and cannot
       * write into a function, so with a dynamic config it prints the id and
       * stops. Until it is here, every `eas build` refuses with "run eas init"
       * — which reads as the CLI being unconfigured rather than as one missing
       * line, and is the first thing to check if a build will not start.
       *
       * It is not a secret: it identifies the project on Expo's side and is
       * committed on purpose, like the Android package id beside it.
       */
      // eas: { projectId: 'paste-the-id-eas-init-prints-here' },

      /**
       * Where the API lives when there is no dev server to ask.
       *
       * `lib/api.ts` prefers the Expo dev server's host, so this is only read
       * by a standalone build — which is exactly when getting it wrong is
       * hardest to notice, because there is no Metro log to read.
       */
      apiOrigin: config.apiOrigin,
      /** Only meaningful in development, where the origin is http://host:port. */
      apiPort: Number(process.env.API_PORT ?? 3000),
      /** Surfaced on the Account screen so a tester can see which build they hold. */
      appEnv: ENV,
    },
  },
};
