/**
 * PRD-510 follow-ups on an open report: the dated heading each added account
 * sits under, and the retry test both the service and its guarded UPDATE run.
 *
 * A report's `detail` is the reporter's first account followed by zero or more
 * blocks, each `\n\n` + {@link followUpHeading} + `\n` + the added account (a
 * report filed with no account starts straight at its first heading). A new
 * account is a retry when it equals one of those accounts as a whole. A short
 * follow-up that merely appears inside a longer account ("again", "he did it
 * again") is new, and is kept.
 */

/** The dated line naming an account as added by the reporter. */
export function followUpHeading(addedAt: Date): string {
  return `Added by the reporter on ${addedAt.toISOString()}:`;
}

/**
 * Splits a stored `detail` into its accounts: what sits before the first
 * heading, then what follows each. Written in the syntax JavaScript and
 * Postgres regular expressions share, so the SQL twin splits the same way.
 * `^` matches only at the start of the text in both (no multiline flag).
 */
export const FOLLOW_UP_HEADING_PATTERN =
  '(?:^|\\n\\n)Added by the reporter on [0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z:\\n';

const FOLLOW_UP_HEADING_REGEX = new RegExp(FOLLOW_UP_HEADING_PATTERN);

/** Every account a stored `detail` holds, each trimmed, the first account
 *  first. An empty first account (a report filed with no words) is kept as
 *  `''`, which never equals a non-empty follow-up. */
export function reportDetailAccounts(detail: string | null): string[] {
  return (detail ?? '')
    .split(FOLLOW_UP_HEADING_REGEX)
    .map((account) => account.trim());
}

/** Whether `newDetail` (already trimmed) repeats an account `detail` holds. */
export function isRepeatedAccount(
  detail: string | null,
  newDetail: string,
): boolean {
  return reportDetailAccounts(detail).includes(newDetail);
}

/**
 * The SQL twin of {@link isRepeatedAccount} against the row's own `detail`,
 * for the guarded UPDATE. Binds `:newDetail` and `:followUpHeadingPattern`
 * ({@link FOLLOW_UP_HEADING_PATTERN}). Trims each account of the same
 * whitespace `String.prototype.trim` drops in practice (spaces, tabs and
 * line breaks).
 */
export const REPEATED_ACCOUNT_SQL = `CAST(:newDetail AS text) IN (
  SELECT regexp_replace(account, '^\\s+|\\s+$', '', 'g')
    FROM regexp_split_to_table(COALESCE(detail, ''), CAST(:followUpHeadingPattern AS text)) AS account
)`;
