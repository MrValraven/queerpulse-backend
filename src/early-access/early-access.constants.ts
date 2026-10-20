/**
 * `mod_audit_logs` actions for early-access grants. Each row carries the
 * member as `targetUserId` and the feature key as `note`, written in the same
 * transaction as the change, only when something changed.
 */
export const EARLY_ACCESS_AUDIT_ACTIONS = {
  granted: 'early_access_granted',
  revoked: 'early_access_revoked',
} as const;

/** The admin roster for one feature lists at most this many grants, newest first. */
export const EARLY_ACCESS_ROSTER_LIMIT = 200;
