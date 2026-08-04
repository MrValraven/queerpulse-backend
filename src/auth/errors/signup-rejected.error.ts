export type SignupRejectedReason =
  | 'invite_required'
  | 'invite_invalid'
  // The redeemer's Google email does not match the address the invite was
  // pinned to. Distinct from the generic `invite_invalid` so the frontend can
  // tell the recipient the link was meant for a different email, rather than
  // showing the catch-all "invalid or expired invite" copy.
  | 'invite_email_mismatch'
  // The member who sent this invite is no longer active (deactivated, suspended,
  // banned, or erased). Distinct from `invite_invalid` so the frontend can
  // explain the inviter is gone rather than blaming the code.
  | 'invite_inviter_inactive'
  | 'age_attestation_required'
  // The address is on the erasure suppression list: this person deleted their
  // account, and letting a fresh Google sign-in re-create it would quietly
  // undo that. See `../../account/entities/email-suppression.entity.ts`.
  | 'account_suppressed'
  // An admin has switched registration off (`platform_settings`). Existing
  // members are unaffected — this is only reachable on the new-account path.
  | 'registration_disabled';

/**
 * Thrown when a brand-new Google sign-in is not allowed to create an account.
 * The controller maps `reason` to a frontend redirect (`?error=<reason>`).
 */
export class SignupRejectedError extends Error {
  constructor(public readonly reason: SignupRejectedReason) {
    super(reason);
    this.name = 'SignupRejectedError';
  }
}
