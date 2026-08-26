// Shared numeric/time constants for the account module. Centralized here
// (rather than duplicated across `account.service.ts` and
// `account-response.ts`) to avoid a circular import between the two.

export const DAY_MS = 24 * 60 * 60 * 1000;
export const REAUTH_TTL_MS = 5 * 60 * 1000;
export const DELETION_GRACE_DAYS = 30;

// How many days before the scheduled erasure the member is warned that it is
// coming, by `AccountDeletionProcessorService.warnUpcomingDeletions`. Three
// days is short enough that the warning is about something imminent and long
// enough to still act on: cancelling is one click on the delete-account page
// the notification links to, and it stays possible right up to the erasure.
export const DELETION_FINAL_WARNING_LEAD_DAYS = 3;
export const DSAR_DUE_DAYS = 30;

// Signed download links on a ready export job are single-use and expire 7
// days after the archive was built (mirrors `account.api.ts`'s doc comment).
export const EXPORT_LINK_EXPIRY_DAYS = 7;

// How long a READY export job is reused instead of rebuilt. `requestExport`
// builds the whole archive synchronously and stores it as jsonb, so an
// identical repeat request inside this window (a double-click, a retry, a
// second tab) returns the job that already exists rather than persisting a
// second full copy of the member's data. Paired with the per-route throttle on
// `POST /account/export`.
export const EXPORT_REUSE_WINDOW_MS = 60 * 60 * 1000;

// RETIRED: `DEFAULT_EMAIL_PREFERENCES` / `LOCKED_EMAIL_CATEGORIES`.
//
// They described a matrix of email-notification categories that no sender ever
// read, for a channel QueerPulse does not have and never will. Do not add an
// email category here. The preferences that genuinely gate delivery are the
// in-app and push categories in
// `src/notifications/notification-preferences.ts`.
