/**
 * PRD-372 constants for official conversations and broadcasts.
 *
 * The sender identity is the platform house account created by genesis. Its
 * identity is repeated here instead of imported from `src/genesis`, because
 * that module is built to be deleted in one commit once bootstrap is done
 * (the same reason `AddUserIsSystem1782800840000` writes the literal). These
 * values MUST equal `genesis/genesis.constants.ts`.
 */
export const OFFICIAL_SENDER_GOOGLE_ID = 'system:queerpulse';
export const OFFICIAL_SENDER_EMAIL = 'system@queerpulse.com';
export const OFFICIAL_SENDER_FIRST_NAME = 'QueerPulse';
export const OFFICIAL_SENDER_LAST_NAME = '';

/** Body bounds for an official message or broadcast (after sanitising). */
export const OFFICIAL_MESSAGE_MAX_LENGTH = 2000;

/** Members per delivery batch (keyset over `users.id`). */
export const OFFICIAL_BROADCAST_BATCH_SIZE = 500;

/** How many posts run at once inside one batch (a sliding pool). */
export const OFFICIAL_BROADCAST_POST_CONCURRENCY = 10;

/** How long a worker's claim on a broadcast lasts before another may resume it. */
export const OFFICIAL_BROADCAST_LEASE_MINUTES = 5;

/** Claims after which a broadcast that never finishes is marked `failed`. */
export const OFFICIAL_BROADCAST_MAX_ATTEMPTS = 5;

/** `GET /admin/official-messages/broadcasts` returns this many, newest first. */
export const OFFICIAL_BROADCAST_HISTORY_LIMIT = 50;

/** Recipient typeahead: shortest term it fires on, and the row cap. */
export const OFFICIAL_RECIPIENT_SEARCH_MIN_LENGTH = 2;
export const OFFICIAL_RECIPIENT_SEARCH_LIMIT = 20;

/** `mod_audit_logs.action` values (a varchar column, no enum DDL needed). */
export const OFFICIAL_MESSAGE_SENT_ACTION = 'official_message_sent';
export const OFFICIAL_BROADCAST_SENT_ACTION = 'official_broadcast_sent';

/** Stable machine codes the admin page branches on. */
export const OFFICIAL_RECIPIENT_NOT_FOUND_CODE = 'OFFICIAL_RECIPIENT_NOT_FOUND';
export const OFFICIAL_BROADCAST_IDEMPOTENCY_CONFLICT_CODE =
  'OFFICIAL_BROADCAST_IDEMPOTENCY_CONFLICT';
