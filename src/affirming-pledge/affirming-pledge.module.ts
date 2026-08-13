import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { AffirmingPledgeController } from './affirming-pledge.controller';
import { AffirmingPledgeService } from './affirming-pledge.service';

/**
 * The LGBTQ+ affirming housing pledge — the mandatory universal baseline the
 * housing/flatmate/landlord/group/coop write + contact surfaces gate on. Exports
 * `AffirmingPledgeService` so each of those modules can call `requireAccepted`
 * inline, exactly as they already call `VerificationService.requireLevel`.
 *
 * `UsersModule` exports the `User` repository (the pledge stamp lives on
 * `users.affirming_pledge_accepted_at`).
 */
@Module({
  imports: [UsersModule],
  controllers: [AffirmingPledgeController],
  providers: [AffirmingPledgeService],
  exports: [AffirmingPledgeService],
})
export class AffirmingPledgeModule {}
