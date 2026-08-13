import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsersModule } from '../users/users.module';
import { AdminVerificationController } from './admin-verification.controller';
import { MemberVerification } from './entities/member-verification.entity';
import { DevPhoneVerificationProvider } from './providers/dev-phone-verification.provider';
import { IDENTITY_VERIFICATION_PROVIDER } from './providers/identity-verification.provider';
import { PHONE_VERIFICATION_PROVIDER } from './providers/phone-verification.provider';
import { StubIdentityVerificationProvider } from './providers/stub-identity-verification.provider';
import { VerificationController } from './verification.controller';
import { VerificationService } from './verification.service';

/**
 * Tiered identity verification. Exports `VerificationService` so the high-risk
 * housing/flatmate/landlord surfaces can gate on a minimum level and hydrate
 * honest badges.
 *
 * The two provider bindings are the SEAMS: swap `DevPhoneVerificationProvider`
 * for a real SMS vendor and `StubIdentityVerificationProvider` for Stripe
 * Identity / Didit, and nothing else in the feature changes.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([MemberVerification]),
    // UsersModule exports the Profile repository (member-ref hydration).
    UsersModule,
  ],
  controllers: [VerificationController, AdminVerificationController],
  providers: [
    VerificationService,
    {
      provide: PHONE_VERIFICATION_PROVIDER,
      useClass: DevPhoneVerificationProvider,
    },
    {
      provide: IDENTITY_VERIFICATION_PROVIDER,
      useClass: StubIdentityVerificationProvider,
    },
  ],
  exports: [VerificationService],
})
export class VerificationModule {}
