import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsersModule } from '../users/users.module';
import { ConsentController } from './consent.controller';
import { ConsentService } from './consent.service';
import { ConsentRecord } from './entities/consent-record.entity';
import { PolicyAcceptance } from './entities/policy-acceptance.entity';
import { PolicyAcceptanceService } from './policy-acceptance.service';

/**
 * Two append-only logs that must not be confused with each other:
 * `consent_record` (cookie/monitoring categories) and `policy_acceptance`
 * (agreement to a Terms/Guidelines revision — ID-14). See the essay on the
 * `PolicyAcceptance` entity for why they are separate tables.
 *
 * `UsersModule` is imported because a policy acceptance also advances the
 * member's `users.terms_version` / `guidelines_version`, which is the pair the
 * frontend gate reads back off `GET /auth/me`.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([ConsentRecord, PolicyAcceptance]),
    UsersModule,
  ],
  controllers: [ConsentController],
  providers: [ConsentService, PolicyAcceptanceService],
  exports: [PolicyAcceptanceService],
})
export class ConsentModule {}
