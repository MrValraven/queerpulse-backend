/**
 * The limits of email code sign-in, in one place (contract "Limits"). The
 * service, the maintenance purge and the controller's copy all read these.
 */

/** How long a code stays valid after it is issued. */
export const EMAIL_CODE_TTL_MS = 10 * 60_000;
/** The same lifetime in whole minutes, for the email template. */
export const EMAIL_CODE_TTL_MINUTES = 10;
/** Wrong tries one challenge allows before it is used up. */
export const EMAIL_CODE_MAX_WRONG_ATTEMPTS = 5;
/** What a refusal for an unknown or foreign challenge reports, so it reads
 *  like a first wrong try on a real one. */
export const EMAIL_CODE_UNKNOWN_CHALLENGE_ATTEMPTS_LEFT =
  EMAIL_CODE_MAX_WRONG_ATTEMPTS - 1; // 4
/** One requester waits this long between codes for one address. */
export const EMAIL_CODE_RESEND_COOLDOWN_MS = 60_000;
/** The window the per-requester request cap counts over. */
export const EMAIL_CODE_REQUESTER_WINDOW_MS = 15 * 60_000;
/** Codes one requester may ask for one address inside that window. */
export const EMAIL_CODE_REQUESTER_WINDOW_LIMIT = 3;
/** The window the per-address caps count over, across every requester. */
export const EMAIL_CODE_ADDRESS_WINDOW_MS = 24 * 60 * 60_000;
/** Codes one address may receive inside that window. */
export const EMAIL_CODE_ADDRESS_SEND_LIMIT = 30;
/** Wrong guesses one address may take inside that window. */
export const EMAIL_CODE_ADDRESS_WRONG_GUESS_LIMIT = 50;
/** How long an expired challenge row is kept before the purge deletes it. */
export const EMAIL_CODE_RETENTION_AFTER_EXPIRY_MS = 24 * 60 * 60_000;
