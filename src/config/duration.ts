/**
 * Parser for the `ms`-style duration strings the JWT config accepts
 * (`15m`, `30d`, `12h`, `90 seconds`, or a bare number of milliseconds).
 *
 * `@nestjs/jwt` hands `expiresIn` straight to `jsonwebtoken`, which parses it
 * with the `ms` package. That package is not a direct dependency here, so this
 * covers the same vocabulary for the places that need the TTL as a NUMBER
 * rather than a string: cookie `maxAge`, and the refresh-row retention window.
 *
 * Returns `null` for anything unparseable so callers can decide between a
 * fallback (config factories) and a boot failure (`env.validation.ts`).
 */
const UNIT_MS: Readonly<Record<string, number>> = {
  ms: 1,
  msec: 1,
  msecs: 1,
  millisecond: 1,
  milliseconds: 1,
  s: 1_000,
  sec: 1_000,
  secs: 1_000,
  second: 1_000,
  seconds: 1_000,
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
  days: 86_400_000,
  w: 604_800_000,
  week: 604_800_000,
  weeks: 604_800_000,
  y: 31_557_600_000,
  yr: 31_557_600_000,
  yrs: 31_557_600_000,
  year: 31_557_600_000,
  years: 31_557_600_000,
};

export function parseDurationMs(value: string | undefined): number | null {
  if (typeof value !== 'string') {
    return null;
  }
  const match = /^\s*(\d+(?:\.\d+)?)\s*([a-z]*)\s*$/i.exec(value);
  if (!match) {
    return null;
  }
  const amount = Number(match[1]);
  // A bare number means milliseconds, matching `ms`.
  const factor = UNIT_MS[(match[2] || 'ms').toLowerCase()];
  if (!Number.isFinite(amount) || amount <= 0 || factor === undefined) {
    return null;
  }
  return Math.round(amount * factor);
}
