/**
 * Shared vocabulary of the admin platform log (`GET /admin/log`).
 *
 * The log is a read-time merge over tables that already exist. Nothing here
 * records anything new about members; every source reads rows the platform
 * already keeps for its own reasons.
 */

export const PLATFORM_LOG_CATEGORIES = [
  'moderation',
  'staff',
  'governance',
  'reviews',
  'members',
] as const;
export type PlatformLogCategory = (typeof PLATFORM_LOG_CATEGORIES)[number];

export const PLATFORM_LOG_RANGES = [
  'today',
  'week',
  'month',
  'quarter',
  'all',
] as const;
export type PlatformLogRange = (typeof PLATFORM_LOG_RANGES)[number];

export type PlatformLogPartyKind =
  'staff' | 'member' | 'system' | 'anonymous' | 'erased';

/** What a source knows about who acted. `erased` is decided at name resolution. */
export type PlatformLogRawPartyKind = Exclude<PlatformLogPartyKind, 'erased'>;

/**
 * The merge key of one entry. `occurredAtExact` is the Postgres timestamp as a
 * fixed-format microsecond UTC string (`2026-10-05T12:00:00.123456Z`), so it
 * sorts correctly as plain text and survives the round trip without the
 * millisecond truncation a JS `Date` would apply.
 */
export interface DecodedPlatformLogCursor {
  occurredAtExact: string;
  sourceKey: string;
  rowId: string;
}

export interface SourceWindow {
  cursor: DecodedPlatformLogCursor | null;
  since: Date | null;
  /** The source returns at most `limit + 1` rows. */
  limit: number;
  memberId: string | null;
  /** True for moderators: member-initiated rows are excluded in SQL. */
  staffRowsOnly: boolean;
  categories: readonly PlatformLogCategory[];
}

export interface PlatformLogSubject {
  label: string;
  route: string | null;
}

export interface PlatformLogRawEntry extends DecodedPlatformLogCursor {
  category: PlatformLogCategory;
  kind: string;
  actorUserId: string | null;
  /** A snapshot or label the table keeps, used when the id no longer resolves. */
  actorFallbackName: string | null;
  actorKind: PlatformLogRawPartyKind;
  targetUserId: string | null;
  targetFallbackName: string | null;
  subject: PlatformLogSubject | null;
  params: Record<string, string>;
  note: string | null;
}

export interface PlatformLogSource {
  readonly key: string;
  readonly categories: readonly PlatformLogCategory[];
  /** `admin` sources are never queried for a moderator. */
  readonly audience: 'staff' | 'admin';
  fetch(window: SourceWindow): Promise<PlatformLogRawEntry[]>;
}

export const PLATFORM_LOG_SOURCES = Symbol('PLATFORM_LOG_SOURCES');

/**
 * `mod_audit_logs` actions filed under "Staff & access". Every other action,
 * including any added in future, is filed under "Moderation".
 */
export const MOD_STAFF_ACTIONS: readonly string[] = [
  'role_changed',
  'staff_role_granted',
  'staff_role_revoked',
  'invite_quota_changed',
  'invite_revoked',
  'conversation_context_viewed',
  'report_message_attachment_viewed',
  'member_sign_in_email_viewed',
  'message_deleted_by_staff',
  'official_message_sent',
  'official_broadcast_sent',
  'sign_in_identity_relinked',
  'sign_in_identity_candidate_dismissed',
  'account_reactivated_by_admin',
  'email_suppression_lifted',
  'member_verified',
];

/** `mod_audit_logs` actions the platform writes itself, with a null actor. */
export const MOD_SYSTEM_ACTIONS: readonly string[] = ['ban_hold_expired'];
