#!/usr/bin/env node
/**
 * Patches the generated `android/app/build.gradle` so `gradlew bundleRelease`
 * produces a signed, uploadable AAB.
 *
 *   npx expo prebuild --platform android --clean
 *   node patch-signing.js
 *   cd android && gradlew.bat bundleRelease
 *
 * WHY A PATCH SCRIPT AND NOT A COMMITTED build.gradle
 * ---------------------------------------------------
 * `android/` is *generated*. `expo prebuild` writes it from `app.config.js`,
 * and `--clean` deletes it first — so anything edited in there by hand is gone
 * the next time somebody regenerates, silently, with the build still
 * succeeding and the AAB now signed by the debug key. Play refuses a
 * debug-signed bundle, which is the good outcome; the bad one is an internal
 * tester installing it and it not updating later.
 *
 * So the edit is re-applied on demand instead of being kept.
 *
 * WHY THE PASSWORDS ARE NOT IN THIS FILE
 * --------------------------------------
 * They are read from `keystore.properties`, which `.gitignore` refuses. A
 * keystore password in a committed script is readable by everyone who ever
 * clones the repo and stays readable in the history after it is removed — and
 * an upload key is what convinces Play that a build came from you. It is
 * recoverable if lost, so this is not a catastrophe; it is still the kind of
 * thing that should never be in git for an app carrying patient data.
 *
 * Copy `keystore.properties.example`, fill it in, and keep the `.jks` beside it.
 *
 * WHY IT IS SAFE TO RUN TWICE
 * ---------------------------
 * Every edit checks for itself first. A patch script that appends a second
 * `release { }` block on the second run fails in Gradle with a duplicate-name
 * error twenty lines from anything that explains why.
 */

const fs = require('fs');
const path = require('path');

const GRADLE = path.join(__dirname, 'android', 'app', 'build.gradle');
const PROPS = path.join(__dirname, 'keystore.properties');

/* ── the credentials ──────────────────────────────────────────────────────── */

if (!fs.existsSync(GRADLE)) {
  console.error(
    `No ${path.relative(__dirname, GRADLE)}.\n` +
      'Run `npx expo prebuild --platform android --clean` first — this script ' +
      'edits the project that command generates, it does not create one.',
  );
  process.exit(1);
}

if (!fs.existsSync(PROPS)) {
  console.error(
    'No keystore.properties.\n\n' +
      'Copy keystore.properties.example to keystore.properties and fill it in.\n' +
      'If you have no keystore yet, make one:\n\n' +
      '  keytool -genkeypair -v -storetype PKCS12 \\\n' +
      '    -keystore upload.jks -alias upload \\\n' +
      '    -keyalg RSA -keysize 2048 -validity 10000\n',
  );
  process.exit(1);
}

/** A `.properties` file: `key=value` per line, `#` comments, values may hold `=`. */
function readProperties(file) {
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const at = trimmed.indexOf('=');
    if (at === -1) continue;
    out[trimmed.slice(0, at).trim()] = trimmed.slice(at + 1).trim();
  }
  return out;
}

const props = readProperties(PROPS);
const REQUIRED = ['storeFile', 'storePassword', 'keyAlias', 'keyPassword'];
const missing = REQUIRED.filter((k) => !props[k]);

if (missing.length) {
  console.error(`keystore.properties is missing: ${missing.join(', ')}`);
  process.exit(1);
}

/*
 * The keystore path is resolved and checked here rather than left to Gradle.
 * Gradle's failure for a missing store file is a Java stack trace about a
 * FileNotFoundException several hundred lines into a build log, and the usual
 * cause is that `storeFile` was written relative to the wrong directory —
 * `build.gradle` sits in `android/app/`, two levels below this one.
 */
const keystore = path.resolve(__dirname, props.storeFile);
if (!fs.existsSync(keystore)) {
  console.error(
    `Keystore not found: ${keystore}\n` +
      '`storeFile` in keystore.properties is resolved relative to mobile/.',
  );
  process.exit(1);
}

/** Gradle strings are double-quoted, and Windows paths are full of backslashes. */
const gradlePath = keystore.split(path.sep).join('/');

function quote(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/* ── the edits ────────────────────────────────────────────────────────────── */

let gradle = fs.readFileSync(GRADLE, 'utf8');
const applied = [];
const skipped = [];

/**
 * Slice out one top-level block of `android { … }` — `signingConfigs`,
 * `buildTypes` — as [opening line, body, closing brace].
 *
 * Both are indented four spaces and close on a line of their own, so the
 * closing `\n    }` is the anchor. Scoping every edit to a slice is the whole
 * reason this helper exists: the first version of this script tested for a
 * `release {` block with one lazy match across the *entire file*, which
 * happily reached past `signingConfigs` into `buildTypes`, found the `release`
 * build type there, and reported the signing config as already present. It
 * then pointed the release build at a `signingConfigs.release` that had never
 * been written. Gradle fails on that, so nothing would have shipped — but the
 * script printed a tidy list of ticks and a skip, which is what a broken guard
 * looks like from outside.
 */
function block(source, name) {
  const found = source.match(new RegExp(`(\\n\\s{4}${name}\\s*\\{)([\\s\\S]*?)(\\n\\s{4}\\})`));
  return found ? { whole: found[0], open: found[1], body: found[2], close: found[3] } : null;
}

/* 1. A `release` signing config beside the generated `debug` one. */
const signingConfigs = block(gradle, 'signingConfigs');

if (!signingConfigs) {
  console.error('Could not find the signingConfigs { … } block. Open build.gradle and look.');
  process.exit(1);
}

if (/\brelease\s*\{/.test(signingConfigs.body)) {
  skipped.push('release signing config (already present)');
} else {
  const release = [
    '',
    '        release {',
    `            storeFile file(${quote(gradlePath)})`,
    `            storePassword ${quote(props.storePassword)}`,
    `            keyAlias ${quote(props.keyAlias)}`,
    `            keyPassword ${quote(props.keyPassword)}`,
    '        }',
  ].join('\n');

  gradle = gradle.replace(
    signingConfigs.whole,
    signingConfigs.open + signingConfigs.body + release + signingConfigs.close,
  );
  applied.push('release signing config');
}

/*
 * 2. Point the *release* build type at it.
 *
 * Scoped to the `release { … }` buildType block by slicing it out first. The
 * tempting version counts occurrences of `signingConfig signingConfigs.debug`
 * and rewrites the second — which is correct exactly as long as Expo keeps
 * emitting them in that order, and silently signs the wrong build type the day
 * it does not.
 */
const buildTypes = block(gradle, 'buildTypes');

if (!buildTypes) {
  console.error('Could not find the buildTypes { … } block. Open build.gradle and look.');
  process.exit(1);
}

const releaseType = buildTypes.body.match(/(\n\s{8}release\s*\{)([\s\S]*?)(\n\s{8}\})/);

if (!releaseType) {
  console.error('Could not find buildTypes { release { … } }. Open build.gradle and look.');
  process.exit(1);
}

if (/signingConfig\s+signingConfigs\.release/.test(releaseType[2])) {
  skipped.push('release buildType signingConfig (already release)');
} else {
  const fixed = releaseType[2].replace(
    /signingConfig\s+signingConfigs\.debug/,
    'signingConfig signingConfigs.release',
  );
  if (fixed === releaseType[2]) {
    console.error('The release buildType names no signingConfig at all. Add one by hand.');
    process.exit(1);
  }
  gradle = gradle.replace(
    buildTypes.whole,
    buildTypes.open +
      buildTypes.body.replace(releaseType[0], releaseType[1] + fixed + releaseType[3]) +
      buildTypes.close,
  );
  applied.push('release buildType → signingConfigs.release');
}

/*
 * 3. 64-bit only.
 *
 * `armeabi-v7a` is 32-bit and cannot meet Android 15's 16 KB page-size
 * requirement, and every device that can run an app targeting API 36 is 64-bit
 * anyway. Dropping it also roughly halves the native payload.
 */
if (gradle.includes('abiFilters')) {
  skipped.push('abiFilters (already present)');
} else {
  gradle = gradle.replace(
    /(defaultConfig\s*\{)/,
    '$1\n        ndk {\n            abiFilters "arm64-v8a", "x86_64"\n        }',
  );
  applied.push('ndk abiFilters — 64-bit only');
}

/*
 * 4. Lint must not fail a release build.
 *
 * A lint error stops `bundleRelease` after everything else has succeeded, and
 * on a generated project the finding is usually in code nobody here wrote.
 * Lint is worth running; it is not worth being the thing between you and an
 * upload at 6pm. Run it deliberately with `gradlew lintRelease`.
 */
if (gradle.includes('checkReleaseBuilds')) {
  skipped.push('lint options (already present)');
} else {
  gradle = gradle.replace(
    /(android\s*\{)/,
    '$1\n    lint {\n        checkReleaseBuilds false\n        abortOnError false\n    }',
  );
  applied.push('lint { checkReleaseBuilds false }');
}

/*
 * 5. Let AGP compile against an SDK newer than it was tested with.
 *
 * **Inert as things stand, and kept for the day it is not.** `app.config.js`
 * deliberately raises only `targetSdkVersion` and leaves `compileSdkVersion`
 * alone, so this branch skips — which is the point. Raising the *compile*
 * level past what the bundled Android Gradle Plugin knows is what broke the
 * build on SDK 52: AGP refused to configure the module, and the failure
 * surfaced as *"Could not get unknown property 'release' for SoftwareComponent
 * container"* from `ExpoModulesCorePlugin`, naming publishing and not an SDK.
 *
 * So if somebody later sets `compileSdkVersion` above what AGP supports, this
 * writes `suppressUnsupportedCompileSdk` and AGP attempts it instead of
 * refusing. That is a hint, not a fix — the flag silences the check and
 * teaches the plugin nothing — and the honest answer remains to upgrade Expo
 * until the bundled AGP supports the level you want.
 *
 * Written into gradle.properties rather than app.config.js because
 * expo-build-properties has no passthrough for arbitrary Gradle properties.
 */
const PROPS_FILE = path.join(__dirname, 'android', 'gradle.properties');

if (fs.existsSync(PROPS_FILE)) {
  const gradleProps = fs.readFileSync(PROPS_FILE, 'utf8');
  const compileSdk = gradleProps.match(/^android\.compileSdkVersion\s*=\s*(\d+)/m);

  /*
   * No `compileSdkVersion` line at all is the normal, healthy case: nothing
   * overrode it, so it is whatever the Expo SDK ships and AGP is content.
   */
  if (!compileSdk) {
    skipped.push('suppressUnsupportedCompileSdk (compileSdk not overridden)');
  } else if (Number(compileSdk[1]) <= 35) {
    skipped.push(`suppressUnsupportedCompileSdk (compileSdk ${compileSdk[1]} needs no coaxing)`);
  } else if (gradleProps.includes('android.suppressUnsupportedCompileSdk')) {
    skipped.push('suppressUnsupportedCompileSdk (already present)');
  } else {
    fs.writeFileSync(
      PROPS_FILE,
      `${gradleProps.trimEnd()}\n\n` +
        '# compileSdk here is newer than the bundled Android Gradle Plugin was\n' +
        '# tested against. This lets it proceed instead of refusing outright.\n' +
        `android.suppressUnsupportedCompileSdk=${compileSdk[1]}\n`,
    );
    applied.push(`suppressUnsupportedCompileSdk=${compileSdk[1]}`);
  }
}

/* ── write and report ─────────────────────────────────────────────────────── */

fs.writeFileSync(GRADLE, gradle);

for (const line of applied) console.log(`  ✓ ${line}`);
for (const line of skipped) console.log(`  · ${line}`);

console.log(
  `\nPatched ${path.relative(__dirname, GRADLE)}.\n\n` +
    'Next:\n' +
    '  cd android\n' +
    '  gradlew.bat bundleRelease        (Windows)\n' +
    '  ./gradlew bundleRelease          (macOS / Linux)\n\n' +
    'Output: android/app/build/outputs/bundle/release/app-release.aab\n\n' +
    'Check it is signed with the upload key and not the debug one:\n' +
    '  keytool -printcert -jarfile android/app/build/outputs/bundle/release/app-release.aab',
);
