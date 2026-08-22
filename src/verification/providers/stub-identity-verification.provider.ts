import { BadRequestException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  IdentityCallbackResult,
  IdentityVerificationProvider,
  IdentityVerificationSession,
  STUB_IDENTITY_PROVIDER_NAME,
} from './identity-verification.provider';

/**
 * Stub identity provider for local development and manual review. It does NOT
 * talk to any real KYC vendor: `createSession` mints an opaque ref and points
 * the member at an in-app placeholder page, and `parseCallback` trusts an
 * unsigned dev payload of `{ providerRef, status }`.
 *
 * Replace this class with a real provider (Stripe Identity / Didit) in
 * `VerificationModule`. The real `parseCallback` MUST verify the provider's
 * webhook signature over the raw body before returning `verified: true`.
 */
@Injectable()
export class StubIdentityVerificationProvider implements IdentityVerificationProvider {
  readonly name = STUB_IDENTITY_PROVIDER_NAME;

  createSession(_userId: string): Promise<IdentityVerificationSession> {
    const providerRef = `stub_${randomUUID()}`;
    return Promise.resolve({
      providerRef,
      // A real provider returns its own hosted verification URL. Locally we
      // point at an in-app placeholder that immediately posts the callback.
      redirectUrl: `/housing/verify/identity/stub?ref=${providerRef}`,
    });
  }

  parseCallback(payload: unknown): IdentityCallbackResult {
    // DEV ONLY — trusts the JSON. A real provider verifies an HMAC signature
    // over the raw request body here before trusting anything.
    const body = payload as { providerRef?: unknown; status?: unknown };
    if (typeof body?.providerRef !== 'string') {
      throw new BadRequestException('Missing providerRef');
    }
    return {
      providerRef: body.providerRef,
      verified: body.status === 'verified',
    };
  }
}
