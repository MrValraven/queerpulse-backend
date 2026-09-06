/**
 * PRD-249. The `YYYY-MM` month a tenancy started or ended, and the rules for
 * comparing two of them.
 *
 * MONTH PRECISION IS THE PRODUCT DECISION, not a shortcut. A recommendation is
 * a public, named rating of a real third party, and the tenancy window is there
 * so a reader can weigh it ("they rented there for three years, ending last
 * spring"). A full date would ask the author for a day they do not remember and
 * then print it as though they did. `YYYY-MM` says exactly what is known.
 *
 * The strings sort lexicographically in chronological order, which is the whole
 * reason for the zero-padded fixed-width format: comparing two windows never
 * needs a date parse.
 */

/** `YYYY-MM`, with a real month number. Year bounds are checked separately. */
export const TENANCY_MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * The earliest tenancy month the form accepts. Not a guess at how long anyone
 * has been renting: it is a typo floor, so a mistyped `0202-05` is refused at
 * the boundary instead of being stored and rendered as a tenancy in the third
 * century.
 */
const EARLIEST_TENANCY_YEAR = 1950;

/** The `YYYY-MM` a `Date` falls in, in UTC. */
export function tenancyMonthOf(when: Date): string {
  const year = when.getUTCFullYear();
  const month = String(when.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

/** Whether `value` is a well-formed month inside the accepted year range. */
export function isTenancyMonth(value: string): boolean {
  if (!TENANCY_MONTH_PATTERN.test(value)) return false;
  const year = Number(value.slice(0, 4));
  return year >= EARLIEST_TENANCY_YEAR;
}

/** The floor, for the DTO's own message and for tests. */
export const EARLIEST_TENANCY_MONTH = `${EARLIEST_TENANCY_YEAR}-01`;
