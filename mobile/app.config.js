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
    scheme: 'onecare-dev',
    iconSuffix: '-development',
  },
  staging: {
    name: 'My Hospital (staging)',
    packageId: 'com.sawera.myhospital.staging',
    apiOrigin: process.env.API_ORIGIN ?? 'https://staging.example.com',
    scheme: 'onecare-staging',
    iconSuffix: '-staging',
  },
  production: {
    name: 'My Hospital',
    packageId: 'com.sawera.myhospital',
    apiOrigin: process.env.API_ORIGIN ?? 'https://hms.sawera.info',
    scheme: 'onecare',
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

/**
 * Android's `versionCode`, and the one number a local build will not invent.
 *
 * EAS keeps this remotely and increments it per build (`appVersionSource:
 * "remote"` in `eas.json`). A Gradle build has no such memory, so it is here —
 * and Play refuses any upload whose `versionCode` is not strictly higher than
 * the last one it accepted. That refusal arrives *after* a fifteen-minute
 * build and an upload, which is why this sits at the top of the file rather
 * than buried in the Android block.
 *
 * **Bump it before every release build.** It is unrelated to `version` below:
 * that string is what a person reads on the store page, this integer is what
 * Android compares. They move independently and a release can change one
 * without the other.
 */
const VERSION_CODE = Number(process.env.ANDROID_VERSION_CODE ?? 1);

/**
 * The Android SDK level this **targets**, and deliberately not what it
 * compiles against.
 *
 * 36 because Play has refused anything lower since 31 August 2026.
 *
 * `compileSdkVersion` is left alone on purpose, and that distinction is the
 * whole of a day lost. Setting *both* to 36 on SDK 52 broke the build with
 * *"Could not get unknown property 'release' for SoftwareComponent
 * container"* — a message about publishing, from `ExpoModulesCorePlugin`,
 * naming nothing to do with an SDK level. The cause was the **compile**
 * level: that AGP had been tested to 35 and would not configure the module
 * above it. `targetSdkVersion` was never what it objected to.
 *
 * AGP tolerates a target above its compile level — it warns. SDK 53 brings
 * AGP 8.8.2, and the sibling project on the same toolchain has shipped sixty
 * releases targeting 36 with compileSdk untouched. Raising compileSdk buys
 * nothing here: it decides which APIs the code may *call*, and this app calls
 * none that are new in 36.
 *
 * The lever remains for the case where 36 turns out to misbehave at runtime:
 *
 *   $env:ANDROID_TARGET_SDK = "35"    # builds, but Play will not take it
 */
const ANDROID_SDK = Number(process.env.ANDROID_TARGET_SDK ?? 36);

/*
 * THERE IS NO LONGER AN `ANDROID_NEW_ARCH` LEVER, AND THAT IS NOT AN OVERSIGHT
 * ---------------------------------------------------------------------------
 * This file used to expose `ANDROID_NEW_ARCH=false`, which turned off React
 * Native's new architecture and with it the C++ codegen whose object paths
 * overflow Windows' 260-character limit. It was the escape hatch that produced
 * the first installable build of this app.
 *
 * It cannot work any more. **RN 0.82 ignores `newArchEnabled=false`** — the
 * legacy architecture is gone rather than deprecated — and Expo SDK 55 removed
 * `newArchEnabled` from the app config schema altogether. SDK 57 is RN 0.86, so
 * the flag is not merely ineffective here, it is not a key this config accepts.
 *
 * The lever was deleted rather than left in place reading `!== 'false'` against
 * a value nothing consumes. A knob that no longer does anything is the exact
 * failure this project keeps reopening: it reads as a decision somebody made,
 * somebody sets it during a bad afternoon, and the build fails identically
 * while they believe they have changed something.
 *
 * So the codegen is unconditional, and **the path length is now a hard
 * constraint rather than a preference**. It is why this working copy lives at
 * `C:\hms` — 255 characters against the limit, five to spare. A native module
 * with longer codegen directories than
 * `react-native-safe-area-context`'s puts it back over, and the remedy will be
 * a shorter root, not a flag. `patch-signing.js` measures it before Gradle
 * starts; DEPLOY-ANDROID.md section 3c has the arithmetic.
 */

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

    /*
     * Square, full-bleed, no transparency. Both stores mask the corners
     * themselves, so artwork that arrives pre-rounded is rounded twice and
     * shows a dark crescent inside the mask.
     */
    icon: `./assets/icon${config.iconSuffix}.png`,

    /*
     * The splash screen is configured by the `expo-splash-screen` plugin below
     * rather than by a top-level `splash` key. That key is **not in SDK 57's
     * config schema at all** — `splash` now means the PWA splash under `web` —
     * so leaving it here would not be a deprecation warning, it would be a
     * field Expo silently ignores while the app ships with no splash artwork.
     */

    ios: {
      supportsTablet: false,
      bundleIdentifier: config.packageId,
      infoPlist: {
        NSFaceIDUsageDescription: 'Unlock My Hospital to view patient information.',
      },
    },

    android: {
      package: config.packageId,
      versionCode: VERSION_CODE,
      permissions: ['USE_BIOMETRIC', 'USE_FINGERPRINT'],

      /*
       * `edgeToEdgeEnabled` used to be declared here and is **gone from the SDK
       * 57 schema** — removed in SDK 55, because edge-to-edge became mandatory
       * and always-on when targeting Android 16. There is nothing to opt into
       * any more; the prebuild template writes `edgeToEdgeEnabled=true` into
       * `android/gradle.properties` itself.
       *
       * Which means the behaviour is unchanged and the obligation is unchanged:
       * Android draws app content under the status and navigation bars. The app
       * is built for it — `AppHeader` wraps itself in a `SafeAreaView
       * edges={['top']}` and the tab bar takes its bottom inset from the
       * navigator — and neither of those can prove how it *looks*. A header
       * sitting under the clock is the kind of fault this project has twice
       * found only by rendering something and looking at it. Still the first
       * thing to check on a real handset.
       */
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

      /*
       * The splash screen, which was a top-level `splash` key until SDK 57
       * removed it from the schema.
       *
       * The options are the same three and mean the same things. The mark is a
       * third of the canvas rather than the whole of it, because `contain` fits
       * this image to the screen's width; `backgroundColor` is the image's own
       * field colour so the letterboxing does not show as a band above and
       * below the artwork.
       */
      [
        'expo-splash-screen',
        {
          image: `./assets/splash${config.iconSuffix}.png`,
          resizeMode: 'contain',
          backgroundColor: BRAND_FIELD,
        },
      ],

      /*
       * The Android build settings a generated project cannot be asked for
       * afterwards — these have to be in place *before* `expo prebuild` writes
       * `android/`, because that is the moment the Gradle files are produced.
       *
       * `targetSdkVersion` is not a preference. Since 31 August 2026 Play
       * rejects any upload targeting lower than 36. SDK 57 already defaults to
       * 36, so this line is belt-and-braces rather than load-bearing as it was
       * on SDK 53 — it is kept because it also keeps the `ANDROID_TARGET_SDK`
       * lever, and because a default that moves under us is exactly the kind of
       * thing discovered by an upload being refused. There is no matching
       * `compileSdkVersion`, for the reason given where `ANDROID_SDK` is
       * declared: raising *that* is what broke the build, and it buys nothing.
       *
       * `useLegacyPackaging: false` loads native libraries straight out of the
       * APK, which is what Android 15's 16 KB memory pages require. The old
       * behaviour extracted them at install time and fails on those devices.
       *
       * Minification and resource shrinking are on because this is a release
       * build of an app that carries patient data — a smaller download is the
       * lesser reason. Watch the first shrunk build for anything reached
       * reflectively: that is where shrinking breaks things, and it breaks them
       * at runtime.
       *
       * The option is `enableMinifyInReleaseBuilds` and used to be
       * `enableProguardInReleaseBuilds`, renamed in SDK 54 and **absent from
       * the SDK 57 reference**. Worth naming because expo-build-properties does
       * not reject an unknown key loudly: the old name would have left
       * minification quietly off in a build that reads as configured for it.
       */
      [
        'expo-build-properties',
        {
          android: {
            targetSdkVersion: ANDROID_SDK,
            useLegacyPackaging: false,
            enableMinifyInReleaseBuilds: true,
            enableShrinkResourcesInReleaseBuilds: true,
          },
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
      eas: { projectId: 'e14e9702-8f6f-4b34-9da1-766e7d3c68d4' },

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
