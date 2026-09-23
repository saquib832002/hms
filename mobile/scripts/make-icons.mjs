#!/usr/bin/env node
/**
 * Generates every icon the app and the Play listing need, from one description
 * of the artwork held in this file.
 *
 *   cd mobile && npm install && npm run icons
 *
 * WHY THE ARTWORK LIVES IN A SCRIPT RATHER THAN IN PNGs
 * -----------------------------------------------------
 * Twelve PNGs that have to agree with each other is twelve things to re-export
 * by hand the day somebody changes the red. The sizes are also not decorative —
 * Android crops an adaptive icon to a shape the manufacturer chooses, and a mark
 * drawn to the edge of the canvas loses its arms on a Samsung and keeps them on
 * a Pixel. So the geometry is written once and every output is derived from it.
 *
 * WHY NOT A RED CROSS ON WHITE
 * ----------------------------
 * The red cross on a **white ground** is protected under the Geneva Conventions
 * and is an offence to use commercially in most countries this product targets —
 * the ICRC enforces it, and app stores have pulled listings over it. So has the
 * inverse, white on red, which is the Swiss flag. A red cross on a *dark* field
 * is neither of those and is what the mark below is: `#0D1317` behind it, never
 * white, never a red background. If the field is ever lightened, that is the
 * thing to stop and check rather than a styling choice.
 *
 * WHY THE HEARTBEAT IS CUT OUT RATHER THAN DRAWN ON
 * -------------------------------------------------
 * It is a stroke in the *field* colour, so it reads as a notch taken out of the
 * cross rather than a line laid over it. That survives being shrunk: an added
 * line thins until it disappears, while a cut-out keeps its shape as long as the
 * cross has any shape at all. It is also what makes the adaptive icon work — the
 * foreground layer is transparent apart from the mark, and Android composites it
 * over `backgroundColor`, so the cut only stays invisible while the two match.
 * `FIELDS` below is the single place both are read from.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const HERE = dirname(fileURLToPath(import.meta.url));
const ASSETS = resolve(HERE, '..', 'assets');
const STORE = resolve(HERE, '..', '..', 'store');

/* ── palette ──────────────────────────────────────────────────────────────── */

/** The cross. A gradient, but a shallow one — it must still read as one colour. */
const RED_LIGHT = '#FF4A52';
const RED_DARK = '#CE1B25';

/**
 * The field, per build.
 *
 * `app.config.js` reads the same three keys for `backgroundColor`, so the
 * adaptive icon's transparent gaps and the splash screen behind the mark cannot
 * drift from the artwork. Dev and staging keep the same dark field and gain a
 * coloured band along the bottom: tinting the whole field would have put a red
 * cross on amber, which is unreadable at 48px, and the point of the band is to
 * be legible on a home screen beside the real app rather than to be pretty.
 */
const FIELDS = {
  production: { field: '#0D1317', band: null },
  staging: { field: '#0D1317', band: '#FFB020' },
  development: { field: '#0D1317', band: '#4BDCFF' },
};

/* ── geometry, in a 1024 box ──────────────────────────────────────────────── */

const BOX = 1024;

/**
 * The plus, as two rounded rectangles.
 *
 * One shared gradient in user space rather than one per rectangle: with the
 * default object-bounding-box units the arms would be shaded against their own
 * differing bounds, and the seam where they cross shows up as a faint cross of
 * its own — visible on a 1024px export and invisible in a code review.
 */
function cross(gradientId) {
  return `
    <rect x="362" y="182" width="300" height="660" rx="72" fill="url(#${gradientId})"/>
    <rect x="182" y="362" width="660" height="300" rx="72" fill="url(#${gradientId})"/>`;
}

/**
 * The heartbeat, cut through the middle of the plus.
 *
 * Every vertex sits far enough inside the horizontal arm that the 72px stroke
 * stays within it — peak 420 against an arm top of 362, trough 612 against a
 * bottom of 662. Pushed any further the stroke breaks the outline of the cross
 * and the mark stops being a cross at a glance, which is the one thing it has
 * to be. The tails run past the arms on both sides and vanish into the field.
 */
function pulse(ink) {
  return `
    <path d="M96 512 H382 L442 420 L506 612 L566 512 H928"
          fill="none" stroke="${ink}" stroke-width="72"
          stroke-linecap="round" stroke-linejoin="round"/>`;
}

function gradient(id) {
  return `
    <linearGradient id="${id}" gradientUnits="userSpaceOnUse"
                    x1="182" y1="182" x2="842" y2="842">
      <stop offset="0" stop-color="${RED_LIGHT}"/>
      <stop offset="1" stop-color="${RED_DARK}"/>
    </linearGradient>`;
}

/** The coloured stripe that tells a staging build apart from the real one. */
function band(colour) {
  return colour ? `<rect x="0" y="904" width="1024" height="120" fill="${colour}"/>` : '';
}

/* ── the five shapes of output ────────────────────────────────────────────── */

/**
 * Store and iOS icon: full bleed, no transparency, square corners.
 *
 * Both platforms mask it themselves. Rounding the corners here would have them
 * rounded twice — a dark sliver inside the mask that looks like a rendering
 * fault and is the commonest mistake in an app icon.
 */
function iconSvg({ field, band: bandColour }, size) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${BOX} ${BOX}">
    <defs>${gradient('g')}</defs>
    <rect width="${BOX}" height="${BOX}" fill="${field}"/>
    ${band(bandColour)}
    ${cross('g')}
    ${pulse(field)}
  </svg>`;
}

/**
 * Android adaptive foreground: transparent, mark inside the safe circle.
 *
 * Android guarantees only the central 66% of the layer survives cropping, so
 * the mark is scaled to 0.72 and centred — anything larger loses the ends of
 * the arms on a device that crops to a circle, and that is a decision made by
 * whoever built the phone rather than by us. The band is deliberately absent:
 * it lives at the bottom edge, which is exactly what gets cropped away.
 */
function adaptiveSvg({ field }, size) {
  const scale = 0.72;
  const offset = (BOX - BOX * scale) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${BOX} ${BOX}">
    <defs>${gradient('g')}</defs>
    <g transform="translate(${offset} ${offset}) scale(${scale})">
      ${cross('g')}
      ${pulse(field)}
    </g>
  </svg>`;
}

/**
 * Splash: the mark at a third of the canvas, on the field.
 *
 * Expo fits this image to the screen width under `resizeMode: contain`, so a
 * full-bleed mark would arrive as a cross the width of the phone. The field is
 * painted into the image *and* set as `backgroundColor`, so the letterboxing
 * above and below is the same colour as the image and the seam does not show.
 */
function splashSvg({ field }, size) {
  const scale = 0.5;
  const offset = (BOX - BOX * scale) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${BOX} ${BOX}">
    <defs>${gradient('g')}</defs>
    <rect width="${BOX}" height="${BOX}" fill="${field}"/>
    <g transform="translate(${offset} ${offset}) scale(${scale})">
      ${cross('g')}
      ${pulse(field)}
    </g>
  </svg>`;
}

/**
 * Android notification icon: a white silhouette on transparent, and nothing else.
 *
 * Android throws away every colour in this image and tints what is left, so a
 * red cross arrives as a white cross and a heartbeat cut in the field colour
 * arrives as part of the silhouette — the notch would fill in and the mark would
 * be a solid plus anyway. It is drawn as a plain cross for that reason rather
 * than left to be discovered on a device. Without this file Android draws a grey
 * square, which is what an app looks like when nobody checked.
 */
function notificationSvg(size) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${BOX} ${BOX}">
    <g fill="#FFFFFF">
      <rect x="362" y="182" width="300" height="660" rx="72"/>
      <rect x="182" y="362" width="660" height="300" rx="72"/>
    </g>
  </svg>`;
}

/**
 * Play feature graphic, 1024×500.
 *
 * No text. A font named here is resolved by whatever is installed on the
 * machine running this script, so the app's name would render in one typeface
 * on a laptop and another in CI, or in a fallback that fits badly — and the one
 * asset nobody re-checks is the one that only appears on the store page. Add the
 * wordmark over this in a design tool, where you can see it.
 */
function featureGraphicSvg({ field }) {
  const scale = 0.42;
  const cx = 300;
  const cy = 250;
  const tx = cx - 512 * scale;
  const ty = cy - 512 * scale;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="500" viewBox="0 0 1024 500">
    <defs>${gradient('g')}</defs>
    <rect width="1024" height="500" fill="${field}"/>
    <path d="M560 250 H660 L700 170 L760 340 L800 250 H1024"
          fill="none" stroke="#1B262C" stroke-width="14"
          stroke-linecap="round" stroke-linejoin="round"/>
    <g transform="translate(${tx} ${ty}) scale(${scale})">
      ${cross('g')}
      ${pulse(field)}
    </g>
  </svg>`;
}

/* ── write everything ─────────────────────────────────────────────────────── */

const jobs = [];

for (const [env, colours] of Object.entries(FIELDS)) {
  const suffix = env === 'production' ? '' : `-${env}`;
  jobs.push(
    { svg: iconSvg(colours, 1024), out: join(ASSETS, `icon${suffix}.png`) },
    { svg: adaptiveSvg(colours, 1024), out: join(ASSETS, `adaptive-icon${suffix}.png`) },
    { svg: splashSvg(colours, 1284), out: join(ASSETS, `splash${suffix}.png`) },
  );
}

jobs.push(
  { svg: notificationSvg(96), out: join(ASSETS, 'notification-icon.png') },
  { svg: iconSvg(FIELDS.production, 512), out: join(STORE, 'play-icon-512.png') },
  { svg: featureGraphicSvg(FIELDS.production), out: join(STORE, 'play-feature-graphic.png') },
);

mkdirSync(ASSETS, { recursive: true });
mkdirSync(STORE, { recursive: true });

let failed = 0;

for (const job of jobs) {
  try {
    /*
     * `flatten` on the two store assets and on the icons, never on the adaptive
     * foreground. Play refuses an icon with an alpha channel and iOS renders one
     * as a black square; the adaptive foreground is refused by Android without
     * one. Getting this backwards produces a build that succeeds and an icon
     * that is wrong, so it is keyed on the file rather than applied everywhere.
     */
    const opaque = !job.out.includes('adaptive-icon') && !job.out.includes('notification-icon');
    let img = sharp(Buffer.from(job.svg));
    if (opaque) img = img.flatten({ background: FIELDS.production.field });
    await img.png({ compressionLevel: 9 }).toFile(job.out);
    console.log(`  ✓ ${job.out.replace(resolve(HERE, '..', '..'), '.')}`);
  } catch (err) {
    failed += 1;
    console.error(`  ✗ ${job.out}\n    ${err.message}`);
  }
}

if (failed) {
  console.error(`\n${failed} icon(s) failed to write.`);
  process.exit(1);
}

console.log(`\n${jobs.length} icons written. app.config.js already points at them.`);
