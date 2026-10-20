import { HttpException, HttpStatus } from '@nestjs/common';

// Studio safety and moderation
// (QUEERPULSE-STUDIO-SAFETY-MODERATION-CONTRACT-2026-10-14.md), spelled as
// the contract and the frontend `studio.types.ts` spell it. Pure, and it
// imports nothing from `studio.constants.ts`, so that file can fold these
// refusals and audit actions into its own maps with no import cycle.

/** The forum's eight content warning themes (spec D7), in this order. Every
 *  list on the wire follows it. */
export const STUDIO_CONTENT_WARNING_IDS = [
  'medical',
  'violence',
  'substances',
  'family-rejection',
  'sexual-content',
  'self-harm',
  'housing-loss',
  'police',
] as const;
export type StudioContentWarningId =
  (typeof STUDIO_CONTENT_WARNING_IDS)[number];
export const STUDIO_CONTENT_WARNINGS_MAX = 8;

export const STUDIO_CLAIM_STATUSES = [
  'submitted',
  'accepted',
  'declined',
  'countered',
  'upheld',
  'rejected',
  'withdrawn',
] as const;
export type StudioClaimStatusValue = (typeof STUDIO_CLAIM_STATUSES)[number];

/** A claim still waiting on someone. One per track and claimant. */
export const STUDIO_CLAIM_LIVE_STATUSES = [
  'submitted',
  'accepted',
  'countered',
] as const;

/** What a track's owners may see. A submitted or declined claim never
 *  reaches them. */
export const STUDIO_CLAIM_OWNER_VISIBLE_STATUSES = [
  'accepted',
  'countered',
  'upheld',
  'rejected',
] as const;
export type StudioOwnerClaimStatus =
  (typeof STUDIO_CLAIM_OWNER_VISIBLE_STATUSES)[number];

/** The live statuses that keep a track withheld (contract). A withdraw of
 *  one of these applies the restore rule. */
export const STUDIO_CLAIM_HOLDING_STATUSES = ['accepted', 'countered'] as const;

/** Every status that keeps a track offline: the holding ones and an upheld
 *  claim (spec 5.1, "upheld: the track stays withheld"). The restore rule
 *  reads this list, so rejecting a second claim never brings back a track
 *  our team upheld a claim about. */
export const STUDIO_CLAIM_WITHHOLDING_STATUSES = [
  'accepted',
  'countered',
  'upheld',
] as const;

export const STUDIO_CLAIMANT_ROLES = ['rights_holder', 'authorised'] as const;
export type StudioClaimantRoleValue = (typeof STUDIO_CLAIMANT_ROLES)[number];

export const STUDIO_CLAIM_LIMITS = {
  originalWorkMax: 200,
  originalLinkMax: 500,
  detailsMax: 2000,
  counterNoteMax: 2000,
  replyMax: 1000,
  staffNoteMax: 1000,
  liveClaimsPerClaimant: 10,
  filingsPerHour: 3,
  // The flag review page size (`STUDIO_LIMITS.staffItemsPerPage`).
  pageSize: 20,
} as const;

function quotedListSql(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ');
}

/** The theme ids quoted for a CHECK or an `IN (...)` list. */
export const STUDIO_CONTENT_WARNING_LIST_SQL = quotedListSql(
  STUDIO_CONTENT_WARNING_IDS,
);
export const STUDIO_CLAIM_HOLDING_LIST_SQL = quotedListSql(
  STUDIO_CLAIM_HOLDING_STATUSES,
);
export const STUDIO_CLAIM_WITHHOLDING_LIST_SQL = quotedListSql(
  STUDIO_CLAIM_WITHHOLDING_STATUSES,
);
export const STUDIO_CLAIM_LIVE_LIST_SQL = quotedListSql(
  STUDIO_CLAIM_LIVE_STATUSES,
);

export function isStudioContentWarningId(
  value: string,
): value is StudioContentWarningId {
  return (STUDIO_CONTENT_WARNING_IDS as readonly string[]).includes(value);
}

/** Known theme ids only, each once, in theme order. A stored list always
 *  goes through this, so its order stays canonical. */
export function normalizeContentWarnings(
  ids: readonly string[] | null | undefined,
): StudioContentWarningId[] {
  const requestedIds = new Set(ids ?? []);
  return STUDIO_CONTENT_WARNING_IDS.filter((warningId) =>
    requestedIds.has(warningId),
  );
}

/** What a listener sees: the artist's warnings and our team's together. */
export function effectiveContentWarnings(
  artistWarnings: readonly string[] | null | undefined,
  staffWarnings: readonly string[] | null | undefined,
): StudioContentWarningId[] {
  return normalizeContentWarnings([
    ...(artistWarnings ?? []),
    ...(staffWarnings ?? []),
  ]);
}

export type StudioSafetyErrorCode =
  | 'studio_track_withheld'
  | 'studio_track_explicit_locked'
  | 'studio_use_copyright_claim'
  | 'studio_claim_own_track'
  | 'studio_claim_exists'
  | 'studio_claim_limit'
  | 'studio_claim_not_countered'
  | 'studio_claim_already_replied'
  | 'studio_claim_not_live'
  | 'studio_claim_not_accepted'
  | 'studio_claim_not_submitted'
  | 'studio_claim_not_decidable'
  | 'studio_track_report_mismatch'
  | 'studio_track_report_not_open';

export const STUDIO_SAFETY_ERRORS: Readonly<
  Record<StudioSafetyErrorCode, { status: HttpStatus; message: string }>
> = {
  // The 410 a listener gets for a withheld track's page, stream and
  // playlists. The body names no track, release, reason or claim.
  studio_track_withheld: {
    status: HttpStatus.GONE,
    message: 'This track is unavailable.',
  },
  studio_track_explicit_locked: {
    status: HttpStatus.CONFLICT,
    message: 'Our team marked this track explicit, so it stays marked.',
  },
  studio_use_copyright_claim: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    message: 'Copyright claims have their own form.',
  },
  studio_claim_own_track: {
    status: HttpStatus.CONFLICT,
    message: "You can't file a copyright claim about your own track.",
  },
  studio_claim_exists: {
    status: HttpStatus.CONFLICT,
    message: 'You already have an open claim about this track.',
  },
  studio_claim_limit: {
    status: HttpStatus.CONFLICT,
    message: 'You can have up to 10 open claims at a time.',
  },
  studio_claim_not_countered: {
    status: HttpStatus.CONFLICT,
    message: 'You can reply once the artist sends a counter-notice.',
  },
  studio_claim_already_replied: {
    status: HttpStatus.CONFLICT,
    message: 'You already replied to this counter-notice.',
  },
  studio_claim_not_live: {
    status: HttpStatus.CONFLICT,
    message: 'This claim is already closed.',
  },
  studio_claim_not_accepted: {
    status: HttpStatus.CONFLICT,
    message: 'A counter-notice goes in once, while the track is held.',
  },
  studio_claim_not_submitted: {
    status: HttpStatus.CONFLICT,
    message: 'Our team already checked this claim.',
  },
  studio_claim_not_decidable: {
    status: HttpStatus.CONFLICT,
    message: 'Our team can uphold or reject a claim once it is accepted.',
  },
  studio_track_report_mismatch: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    message: 'That report is not a Studio report about this track.',
  },
  studio_track_report_not_open: {
    status: HttpStatus.CONFLICT,
    message: 'That report was already handled.',
  },
};

export const STUDIO_SAFETY_ERROR_CODES = Object.keys(
  STUDIO_SAFETY_ERRORS,
) as StudioSafetyErrorCode[];

/** The same body `studioError` writes: `{ statusCode, code, message }`. */
export function studioSafetyError(code: StudioSafetyErrorCode): HttpException {
  const { status, message } = STUDIO_SAFETY_ERRORS[code];
  return new HttpException({ statusCode: status, code, message }, status);
}

/** `mod_audit_logs.action` values the safety routes write. A plain varchar
 *  column, so no enum migration. No row ever names a target member. */
export const STUDIO_SAFETY_AUDIT_ACTIONS = {
  trackMarkedExplicit: 'studio_track_marked_explicit',
  trackWarningAdded: 'studio_track_warning_added',
  claimAccepted: 'studio_copyright_claim_accepted',
  claimDeclined: 'studio_copyright_claim_declined',
  claimUpheld: 'studio_copyright_claim_upheld',
  claimRejected: 'studio_copyright_claim_rejected',
} as const;
export type StudioSafetyAuditAction =
  (typeof STUDIO_SAFETY_AUDIT_ACTIONS)[keyof typeof STUDIO_SAFETY_AUDIT_ACTIONS];
