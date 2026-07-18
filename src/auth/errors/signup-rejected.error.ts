export type SignupRejectedReason =
  | 'invite_required'
  | 'invite_invalid'
  | 'age_attestation_required'
  // The address is on the erasure suppression list: this person deleted their
  // account, and letting a fresh Google sign-in re-create it would quietly
  // undo that. See `../../account/entities/email-suppression.entity.ts`.
  | 'account_suppressed';

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
