import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NotificationsModule } from '../notifications/notifications.module';
import { UsersModule } from '../users/users.module';
import { AdminVerificationController } from './admin-verification.controller';
import { MemberVerification } from './entities/member-verification.entity';
import { VerificationEvent } from './entities/verification-event.entity';
import { VerificationRequest } from './entities/verification-request.entity';
import { IDENTITY_VERIFICATION_PROVIDER } from './providers/identity-verification.provider';
import { StubIdentityVerificationProvider } from './providers/stub-identity-verification.provider';
import { VerificationController } from './verification.controller';
import { VerificationService } from './verification.service';

/**
 * Tiered identity verification. Exports `VerificationService` so the high-risk
 * housing/flatmate/landlord surfaces can gate on a minimum level and hydrate
 * honest badges.
 *
 * The identity provider binding is the SEAM: swap
 * `StubIdentityVerificationProvider` for Stripe Identity / Didit and nothing
 * else in the feature changes. There used to be a matching phone-OTP seam
 * (`PHONE_VERIFICATION_PROVIDER`), but its only implementation was a dev-only
 * stub that logged the OTP in plaintext and was never wired to a real SMS
 * vendor — it was removed rather than left live behind a "never ship this"
 * comment. A member can still reach `phone` level through the manual review
 * path (`submitRequest` / `decideRequest`).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      MemberVerification,
      VerificationEvent,
      VerificationRequest,
    ]),
    // UsersModule exports the Profile repository (member-ref hydration) and
    // the User repository (`computeSignals`'s `accountAgeDays`, off
    // `users.created_at`).
    UsersModule,
    // Notifies the member when an admin overrides/downgrades their level
    // (Task 4 of the audit-trail phase — see NotificationsService).
    NotificationsModule,
  ],
  controllers: [VerificationController, AdminVerificationController],
  providers: [
    VerificationService,
    // Registered as its own provider so the factory below can inject it. Swap
    // this for a real signed provider (Stripe Identity / Didit) when one ships.
    StubIdentityVerificationProvider,
    {
      // The identity-provider binding, guarded. The stub's `parseCallback`
      // trusts an unsigned request body, so binding it while automated
      // elevation is ON (VERIFICATION_AUTOMATED_ELEVATION=true) would let any
      // caller POST a forged /verification/identity/callback and self-grant
      // `id_verified` (finding M9). Refuse to start in that combination rather
      // than ship a dormant self-elevation hole: elevation may only be turned
      // on once a provider that verifies an HMAC signature over the raw body is
      // bound here. env.validation.ts hard-fails on the same flag at boot too;
      // this is the colocated guard at the actual binding, so the check holds
      // even if the provider selection later becomes env-driven.
      provide: IDENTITY_VERIFICATION_PROVIDER,
      useFactory: (
        config: ConfigService,
        stub: StubIdentityVerificationProvider,
      ) => {
        const automatedElevationEnabled =
          config.get<string>('VERIFICATION_AUTOMATED_ELEVATION') === 'true';
        if (automatedElevationEnabled) {
          throw new Error(
            'VERIFICATION_AUTOMATED_ELEVATION=true but the only bound identity provider is the unsigned development stub (StubIdentityVerificationProvider), whose parseCallback trusts an unsigned request body. That combination lets any caller forge /verification/identity/callback and self-grant id_verified. Bind a provider that verifies an HMAC signature over the raw body before enabling automated elevation.',
          );
        }
        return stub;
      },
      inject: [ConfigService, StubIdentityVerificationProvider],
    },
  ],
  exports: [VerificationService],
})
export class VerificationModule {}
