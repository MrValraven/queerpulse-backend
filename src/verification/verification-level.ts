/**
 * A member's identity-assurance tier. This is an ordered ladder — each level
 * implies every level below it — so a required-level check is a rank comparison,
 * never an equality test.
 *
 * `email` is the floor for any account that exists: sign-in is Google-only, and
 * Google only federates a verified email, so simply having an account proves
 * email control. `phone` and `id_verified` each reflect a REAL, recorded
 * verification EVENT (an OTP the member entered, or an external identity
 * provider's success callback) — never a decorative or self-asserted flag. That
 * distinction is the whole point: a badge must be able to point at the event
 * that earned it. `none` exists only for completeness (a future non-Google
 * account path) and no live sign-in path produces it.
 */
export enum VerificationLevel {
  None = 'none',
  Email = 'email',
  Phone = 'phone',
  IdVerified = 'id_verified',
}

/** Low → high. The array index IS the rank used by every comparison below. */
export const VERIFICATION_LEVEL_ORDER: readonly VerificationLevel[] = [
  VerificationLevel.None,
  VerificationLevel.Email,
  VerificationLevel.Phone,
  VerificationLevel.IdVerified,
];

/** Rank of a level on the ladder (higher = more assurance). */
export function levelRank(level: VerificationLevel): number {
  return VERIFICATION_LEVEL_ORDER.indexOf(level);
}

/** True when `actual` is at least `required` on the ladder. */
export function meetsLevel(
  actual: VerificationLevel,
  required: VerificationLevel,
): boolean {
  return levelRank(actual) >= levelRank(required);
}

/**
 * The kind of verification a `member_verifications` row covers. Only
 * `identity` exists today; the dimension exists so a future verification type
 * (e.g. a business/landlord verification) can coexist per member without a
 * schema change — see the `(user_id, type)` uniqueness in
 * `AddVerificationAudit1789100000000`.
 */
export enum VerificationType {
  Identity = 'identity',
}

/**
 * How a member's current level was reached: earned through the ordinary
 * step-up flow (OTP, identity provider callback) versus set directly by an
 * admin override. Surfaced in the admin drawer so a reviewer can tell a real
 * verification event apart from a manual grant.
 */
export enum VerificationGrantedBy {
  MemberEarned = 'member_earned',
  AdminGranted = 'admin_granted',
}

/**
 * The append-only audit action recorded on `verification_events` for every
 * change to a member's verification standing.
 */
export enum VerificationEventAction {
  Submitted = 'submitted',
  Approved = 'approved',
  Rejected = 'rejected',
  Overridden = 'overridden',
  Downgraded = 'downgraded',
  Appealed = 'appealed',
  Withdrawn = 'withdrawn',
}
