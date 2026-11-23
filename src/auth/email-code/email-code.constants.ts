/**
 * The limits of email code sign-in, in one place (contract "Limits"). The
 * service, the maintenance purge and the controller's copy all read these.
 */

/** How long a code stays valid after it is issued. */
export const EMAIL_CODE_TTL_MS = 10 * 60_000;
/** The same lifetime in whole minutes, for the email template. */
export const EMAIL_CODE_TTL_MINUTES = 10;
/**
 * Wrong tries one challenge allows before it is used up. Shared by sign-in and
 * reauth; 3 keeps the daily sign-in guess bound at 90 per address (SEC-11).
 */
export const EMAIL_CODE_MAX_WRONG_ATTEMPTS = 3;
/** What a refusal for an unknown or foreign challenge reports, so it reads
 *  like a first wrong try on a real one. */
export const EMAIL_CODE_UNKNOWN_CHALLENGE_ATTEMPTS_LEFT =
  EMAIL_CODE_MAX_WRONG_ATTEMPTS - 1; // 2
/** One requester waits this long between codes for one address. */
export const EMAIL_CODE_RESEND_COOLDOWN_MS = 60_000;
/** The window the per-requester request cap counts over. */
export const EMAIL_CODE_REQUESTER_WINDOW_MS = 15 * 60_000;
/** Codes one requester may ask for one address inside that window. */
export const EMAIL_CODE_REQUESTER_WINDOW_LIMIT = 3;
/** The window the per-address send cap counts over, across every requester. */
export const EMAIL_CODE_ADDRESS_WINDOW_MS = 24 * 60 * 60_000;
/** Codes one address may receive for one purpose inside that window, from
 *  the shared cap every requester draws on. */
export const EMAIL_CODE_ADDRESS_SEND_LIMIT = 30;
/**
 * The tighter cap for join-request codes (SEC-10). An applicant needs one or
 * two codes, and anyone can type an address into the public form, so this
 * bounds how many confirmation emails a stranger can push into one inbox in a
 * day.
 */
export const EMAIL_CODE_JOIN_REQUEST_ADDRESS_SEND_LIMIT = 10;
/**
 * Trusted-requester allowance (SEC-11). A browser holding a valid
 * `email_code_trusted` cookie for an address (set when it last verified a
 * code for that address) draws its codes from this reserved daily allowance
 * first, then from the shared cap above. A request without that cookie
 * counts against the shared cap alone, so a stranger who spends the shared
 * cap leaves the member's reserve whole. Each send records its bucket in
 * `email_sign_in_challenges.is_trusted_send`. The mail one address can
 * receive per purpose per day stays bounded by the shared cap plus the
 * reserve: 40 sign-in codes, 15 join-request codes.
 *
 * Remaining residual: a requester with no trusted cookie for the address (a
 * first-time applicant, a new device, a browser that cleared its cookies, or
 * one whose cookie names another address, since the cookie holds one address
 * at a time) has only the shared cap, and a stranger can still spend that for
 * the day. That requester also shares the in-memory IP+address buckets in
 * `email-code-throttler.guards.ts` (5 codes an hour, 3 join-request codes a
 * day) with everyone on the same public IP, so a stranger behind the same
 * venue Wi-Fi, CGNAT or household connection can spend those first; a
 * trusted request has buckets of its own there. A stolen trusted cookie lets
 * its holder spend that address's reserve; it is httpOnly and scoped to
 * `/auth/email-code`, grants nothing else, and sign-out clears it.
 */
export const EMAIL_CODE_TRUSTED_ADDRESS_SEND_LIMIT = 10;
/** The reserved allowance for join-request codes. */
export const EMAIL_CODE_JOIN_REQUEST_TRUSTED_ADDRESS_SEND_LIMIT = 5;
/** How long a trusted-requester cookie stays valid; each verify renews it. */
export const EMAIL_CODE_TRUSTED_REQUESTER_TTL_MS = 90 * 24 * 60 * 60_000;
/**
 * The most wrong guesses a stranger can take against the codes one address
 * receives for one purpose in that window: every code allows 3 wrong tries
 * and the shared send cap bounds the codes a requester without the trusted
 * cookie can get. Codes drawn from the trusted allowance take guesses only
 * from the trusted browser that asked for them, adding at most
 * `EMAIL_CODE_TRUSTED_ADDRESS_SEND_LIMIT` times 3 for the member alone. No
 * separate address-wide guess counter exists, because a shared counter let a
 * stranger spend it and lock the member out.
 */
export const EMAIL_CODE_ADDRESS_WRONG_GUESS_BOUND =
  EMAIL_CODE_ADDRESS_SEND_LIMIT * EMAIL_CODE_MAX_WRONG_ATTEMPTS; // 90
/** The same bound for join-request codes, under their tighter send cap. */
export const EMAIL_CODE_JOIN_REQUEST_WRONG_GUESS_BOUND =
  EMAIL_CODE_JOIN_REQUEST_ADDRESS_SEND_LIMIT * EMAIL_CODE_MAX_WRONG_ATTEMPTS; // 30
/** How long an expired challenge row is kept before the purge deletes it. */
export const EMAIL_CODE_RETENTION_AFTER_EXPIRY_MS = 24 * 60 * 60_000;
