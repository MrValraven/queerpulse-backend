/**
 * Seam for a government-ID / biometric identity check. The platform NEVER
 * performs this itself and NEVER stores document images or biometric data
 * (GDPR Art.9) — the entire check is delegated to an external provider
 * (Stripe Identity, Didit, Veriff, …). We hold only an opaque `providerRef` and
 * the resulting level.
 *
 * Flow: `createSession` mints a provider verification session and returns the
 * URL to send the member to; the provider later POSTs a signed result to our
 * callback, which `parseCallback` turns into `{ providerRef, verified }`. The
 * stub implements this with a placeholder redirect and an unsigned callback for
 * local development.
 */
export interface IdentityVerificationSession {
  /** Opaque provider session id — persisted so the callback maps back to us. */
  providerRef: string;
  /** Where to send the member to complete the check (provider-hosted). */
  redirectUrl: string;
}

export interface IdentityCallbackResult {
  providerRef: string;
  verified: boolean;
}

export interface IdentityVerificationProvider {
  /** The provider name recorded on the verification row (e.g. `stub_identity`,
   * `stripe_identity`). */
  readonly name: string;

  createSession(userId: string): Promise<IdentityVerificationSession>;

  /**
   * Turn a raw callback payload into a normalized result. A real provider
   * verifies a signature over the raw body HERE before trusting the payload;
   * the stub trusts the JSON as-is (dev only).
   */
  parseCallback(payload: unknown): IdentityCallbackResult;
}

/**
 * The dev stub's provider name. Exported so consumers can tell the unsigned
 * local stub apart from a real, signature-verifying provider WITHOUT importing
 * the stub class (which would drag a dev-only implementation into production
 * code paths). `VerificationService` refuses to honour identity callbacks, and
 * refuses automatic elevation, when this provider is bound in production.
 */
export const STUB_IDENTITY_PROVIDER_NAME = 'stub_identity';

/** DI token — an interface has no runtime value to inject against. */
export const IDENTITY_VERIFICATION_PROVIDER = Symbol(
  'IDENTITY_VERIFICATION_PROVIDER',
);
