// Shared numeric/time constants for the account module. Centralized here
// (rather than duplicated across `account.service.ts` and
// `account-response.ts`) to avoid a circular import between the two.

export const DAY_MS = 24 * 60 * 60 * 1000;
export const REAUTH_TTL_MS = 5 * 60 * 1000;
export const DELETION_GRACE_DAYS = 30;
export const DSAR_DUE_DAYS = 30;

// Signed download links on a ready export job are single-use and expire 7
// days after the archive was built (mirrors `account.api.ts`'s doc comment).
export const EXPORT_LINK_EXPIRY_DAYS = 7;

// Categories always present in `GET /account/email-preferences`, even before
// the member has ever touched a toggle. `email_preference` rows are overrides
// layered on top of this default matrix.
export const DEFAULT_EMAIL_PREFERENCES: Record<string, boolean> = {
  productUpdates: true,
  communityDigest: true,
  eventReminders: true,
  directMessages: true,
  securityAlerts: true,
};

// ALWAYS_ON transactional categories the frontend marks `locked: true` and
// which `POST /account/email-preferences` refuses to toggle off.
export const LOCKED_EMAIL_CATEGORIES = new Set<string>(['securityAlerts']);
