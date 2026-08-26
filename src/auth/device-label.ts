/**
 * A coarse, human-readable name for the device behind a User-Agent string.
 *
 * WHY THIS EXISTS: `/account/sessions` used to print the raw UA, so the member's
 * only defence against a stolen session was reading
 * `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 …` and
 * deciding whether it was theirs. The stored label is also what
 * `AuthService.issueTokens` compares a new sign-in against, so "have I used this
 * device before?" has one answer shared by the alert and the security page.
 *
 * DELIBERATELY NOT A DEPENDENCY. A UA-parsing library carries a database of
 * thousands of devices, ships updates forever, and would let the label get
 * precise enough to be identifying. Two short ordered tables give
 * "Chrome on macOS" and "Safari on iPhone", which is all either caller needs.
 *
 * DELIBERATELY COARSE, for three reasons that all point the same way:
 *  - User-Agent strings are self-reported, and browsers are actively freezing
 *    and reducing them, so precision here would be false precision.
 *  - The label is compared for equality to decide whether a sign-in is new. A
 *    label carrying a version number would change on every browser update and
 *    alert the member about their own laptop every few weeks.
 *  - The label is written into a notification. It must never narrow a member
 *    down to a specific machine.
 *
 * Every function here is PURE and synchronous: same string in, same label out,
 * no clock, no I/O, no config. That is what makes it unit-testable and what
 * makes the recognition check in `AuthService` deterministic.
 */

/**
 * The label used when the User-Agent is missing or matches nothing known.
 *
 * Stored rather than left NULL so recognition has something to compare: two
 * sign-ins from equally unreadable clients are treated as the same "device",
 * which errs towards NOT alerting. A false alarm about your own phone teaches
 * members to ignore the alert, which costs more than the alert is worth.
 */
export const UNKNOWN_DEVICE_LABEL = 'Unknown device';

/**
 * The longest a stored label may be, matching `refresh_tokens.device_label`.
 *
 * Every label this module can produce is far shorter; the cap exists so a
 * future table entry can never silently overflow the column.
 */
export const DEVICE_LABEL_MAX_LENGTH = 120;

/**
 * Browser families, ordered longest-match-first.
 *
 * Order is load-bearing: Edge and Opera both put `Chrome/` in their UA, and
 * Chrome puts `Safari/` in its own, so the more specific pattern has to be
 * tested first or every Edge user is labelled "Chrome".
 */
const BROWSERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bEdg(?:e|A|iOS)?\//, 'Edge'],
  [/\bOPR\/|\bOpera\b/, 'Opera'],
  [/\bSamsungBrowser\//, 'Samsung Internet'],
  [/\bFirefox\/|\bFxiOS\//, 'Firefox'],
  [/\bCriOS\//, 'Chrome'],
  [/\bChrome\//, 'Chrome'],
  [/\bSafari\//, 'Safari'],
];

/**
 * Platform families, ordered most specific first.
 *
 * iPadOS reports `Macintosh` in desktop mode, so `iPad` is tested before the
 * macOS pattern; Android reports `Linux`, so it is tested before Linux.
 */
const PLATFORMS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\biPhone\b/, 'iPhone'],
  [/\biPad\b/, 'iPad'],
  [/\biPod\b/, 'iPod'],
  [/\bAndroid\b/, 'Android'],
  [/\bCrOS\b/, 'ChromeOS'],
  [/\bWindows\b/, 'Windows'],
  [/\bMac OS X\b|\bMacintosh\b/, 'macOS'],
  [/\bLinux\b/, 'Linux'],
];

function matchFirst(
  userAgent: string,
  table: ReadonlyArray<readonly [RegExp, string]>,
): string | null {
  for (const [pattern, label] of table) {
    if (pattern.test(userAgent)) {
      return label;
    }
  }
  return null;
}

/**
 * The parts a label is built from, exposed separately so a caller that wants to
 * compose its own phrasing (a localised one, say) does not have to re-parse.
 */
export interface DeviceLabelParts {
  browser: string | null;
  platform: string | null;
}

/** The structured form of {@link deviceLabelFromUserAgent}. Pure. */
export function deviceLabelPartsFromUserAgent(
  userAgent?: string | null,
): DeviceLabelParts {
  const raw = typeof userAgent === 'string' ? userAgent : '';
  return {
    browser: matchFirst(raw, BROWSERS),
    platform: matchFirst(raw, PLATFORMS),
  };
}

/**
 * "Chrome on macOS", "Safari on iPhone", or a single half when only one is
 * recognised. Falls back to {@link UNKNOWN_DEVICE_LABEL} rather than guessing.
 *
 * The connective is English on purpose. The backend stays language-neutral for
 * notification COPY (the frontend translates by key), but this is a stored
 * value that has to compare equal across sign-ins, so it cannot depend on which
 * language the member happened to be using at the time. The frontend is free to
 * present the two parts differently; `deviceLabelPartsFromUserAgent` is there
 * for exactly that.
 */
export function deviceLabelFromUserAgent(userAgent?: string | null): string {
  const { browser, platform } = deviceLabelPartsFromUserAgent(userAgent);
  if (browser && platform) {
    return `${browser} on ${platform}`;
  }
  return browser ?? platform ?? UNKNOWN_DEVICE_LABEL;
}
