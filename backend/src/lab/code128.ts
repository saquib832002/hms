/**
 * Code 128, encoded here rather than pulled in as a dependency.
 *
 * WHY CODE 128 AND NOT SOMETHING ELSE
 * -----------------------------------
 * It is what laboratory specimen labels use. Code 39 is the older alternative
 * and is roughly 40% wider for the same data, which matters on a label wrapped
 * round a 13mm blood tube — the printed barcode has to survive being read at an
 * angle on a curved surface, and every millimetre of quiet zone counts. Subset
 * B covers the full upper-case alphanumeric range an accession uses, and every
 * bench scanner made in the last thirty years reads it without configuration.
 *
 * Data Matrix would be better for the very smallest tubes and is a genuinely
 * different problem — a 2D symbology needs Reed–Solomon error correction, which
 * is not something to write from scratch and get subtly wrong. It is absent
 * rather than approximated.
 *
 * WHY NOT A LIBRARY
 * -----------------
 * The two obvious ones each bring a rendering stack this project does not want:
 * `bwip-js` depends on a PostScript interpreter, and `jsbarcode` expects a DOM
 * or a canvas. What is actually needed is the bar pattern as numbers, so the
 * PDF renderer can draw rectangles and a screen can draw an SVG from the same
 * source of truth. That is this file, and it has no imports at all — which is
 * also what lets the clients hold byte-identical copies.
 *
 * THE ENCODING, BRIEFLY
 * ---------------------
 * A symbol is: START-B, one code per character, a modulo-103 checksum, STOP.
 * Each code is six alternating bar/space runs whose widths sum to 11 modules;
 * STOP is seven runs summing to 13. `PATTERNS` holds those run widths as digit
 * strings, indexed by code value.
 */

/**
 * Run-length patterns for code values 0–106, as bar/space widths.
 *
 * Index 0 is the character ' ' in subset B, and the table runs in subset order,
 * so a subset-B character's code value is simply `charCode - 32`. 103 is
 * START-B, 106 is STOP (with its trailing termination bar included).
 */
const PATTERNS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312',
  '132212', '221213', '221312', '231212', '112232', '122132', '122231', '113222',
  '123122', '123221', '223211', '221132', '221231', '213212', '223112', '312131',
  '311222', '321122', '321221', '312212', '322112', '322211', '212123', '212321',
  '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121',
  '313121', '211331', '231131', '213113', '213311', '213131', '311123', '311321',
  '331121', '312113', '312311', '332111', '314111', '221411', '431111', '111224',
  '111422', '121124', '121421', '141122', '141221', '112214', '112412', '122114',
  '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112',
  '421211', '212141', '214121', '412121', '111143', '111341', '131141', '114113',
  '114311', '411113', '411311', '113141', '114131', '311141', '411131', '211412',
  '211214', '211232',
  /*
   * STOP is seven runs, not six, and the seventh is the reason.
   *
   * Every other code is three bars and three spaces summing to 11 modules;
   * STOP carries a trailing 2-module termination bar so the symbol *ends* on a
   * bar. Written as six here first, and the symbol then ended on a space —
   * which scans as truncated on a real reader and looks entirely fine in any
   * test that only checks the bars differ from each other.
   */
  '2331112',
];

const START_B = 104;
const STOP = 106;

/**
 * Encode a string as Code 128 subset B bar widths.
 *
 * Returns alternating run widths in modules, **starting with a bar**: `[2, 1,
 * 1, 2, 3, 2, …]` means a 2-module bar, a 1-module space, a 1-module bar, and
 * so on. Both renderers walk it the same way, which is the point of returning
 * widths rather than pixels.
 *
 * Throws on a character subset B cannot represent. That is deliberate: silently
 * dropping one would produce a label that scans cleanly to the *wrong* value,
 * which in a laboratory means a result filed against the wrong specimen. An
 * accession is digits, hyphens and one upper-case letter, so this never fires
 * in practice — and if it ever does, something upstream is wrong and a thrown
 * error is the only safe outcome.
 */
export function code128Widths(value: string): number[] {
  if (value.length === 0) throw new Error('Nothing to encode');

  const codes: number[] = [START_B];

  for (const ch of value) {
    const code = ch.charCodeAt(0) - 32;
    if (code < 0 || code > 94) {
      throw new Error(`Code 128 subset B cannot encode ${JSON.stringify(ch)}`);
    }
    codes.push(code);
  }

  /*
   * Modulo-103 checksum, weighted by position. The start code counts once and
   * the rest count by their 1-based position — this is the symbology's own
   * check and is separate from the accession's human-readable check character.
   * One protects the scan, the other protects somebody typing it in.
   */
  let checksum = START_B;
  for (let i = 1; i < codes.length; i++) checksum += codes[i] * i;
  codes.push(checksum % 103);

  codes.push(STOP);

  const widths: number[] = [];
  for (const code of codes) {
    for (const digit of PATTERNS[code]) widths.push(Number(digit));
  }
  return widths;
}

/**
 * The symbol as an inline SVG, for a screen.
 *
 * `moduleWidth` is the narrowest bar. Below about 0.25mm printed, a thermal
 * label printer starts merging bars and the symbol stops scanning — the caller
 * decides, because a screen and a label have very different constraints.
 */
export function code128Svg(
  value: string,
  { height = 48, moduleWidth = 2, quietZone = 10 } = {},
): string {
  const widths = code128Widths(value);
  const total = widths.reduce((a, b) => a + b, 0) * moduleWidth + quietZone * 2;

  let x = quietZone;
  const bars: string[] = [];

  widths.forEach((w, i) => {
    const width = w * moduleWidth;
    // Even indices are bars, odd are spaces — the pattern always starts on a bar.
    if (i % 2 === 0) {
      bars.push(`<rect x="${x}" y="0" width="${width}" height="${height}" fill="#000"/>`);
    }
    x += width;
  });

  /*
   * A white background rectangle, always. A barcode drawn on a transparent
   * background over a dark theme is a barcode no scanner can read, and the
   * failure only appears when somebody points a scanner at a screen.
   */
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="${height}" viewBox="0 0 ${total} ${height}">`,
    `<rect width="${total}" height="${height}" fill="#fff"/>`,
    ...bars,
    '</svg>',
  ].join('');
}
