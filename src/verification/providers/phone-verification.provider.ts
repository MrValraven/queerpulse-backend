/**
 * Seam for a phone (SMS OTP) step-up. The dev implementation logs the code
 * instead of sending an SMS; a production implementation would delegate to a
 * real vendor (Twilio Verify, Vonage, MessageBird) that owns code generation,
 * delivery, expiry and rate-limiting. Deliberately NOT integrated here.
 */
export interface PhoneVerificationProvider {
  /**
   * Begin a challenge for `userId` at `phoneNumber` — generate + "send" a code.
   * Never returns the code to the caller (only the member's phone receives it).
   */
  startChallenge(userId: string, phoneNumber: string): Promise<void>;

  /** True when `code` matches the member's outstanding, unexpired challenge. */
  checkChallenge(userId: string, code: string): Promise<boolean>;
}

/** DI token — an interface has no runtime value to inject against. */
export const PHONE_VERIFICATION_PROVIDER = Symbol(
  'PHONE_VERIFICATION_PROVIDER',
);
