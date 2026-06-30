export type SignupRejectedReason = 'invite_required' | 'invite_invalid';

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
