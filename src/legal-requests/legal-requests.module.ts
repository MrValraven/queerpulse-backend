import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Profile } from '../users/entities/profile.entity';
import { AdminLegalRequestsController } from './admin-legal-requests.controller';
import { LegalRequest } from './entities/legal-request.entity';
import { LegalRequestsService } from './legal-requests.service';

/**
 * The register of legal, government and law-enforcement demands (PRD-32).
 *
 * Registers its own `forFeature` copies of `LegalRequest` and `Profile`
 * (TypeORM permits overlapping registrations) rather than importing
 * `UsersModule`, the self-contained pattern `AdminDsarModule` follows. The
 * profiles repository is here for one thing only: the write-time snapshot of
 * the recording admin's display name.
 *
 * `LegalRequestsService` is deliberately NOT exported. The public aggregate is
 * counted by `TransparencyService` straight off the table, so no other module
 * ever needs the write side, and keeping it unexported means a future import
 * of this module cannot quietly hand a second caller the power to write the
 * register.
 */
@Module({
  imports: [TypeOrmModule.forFeature([LegalRequest, Profile])],
  controllers: [AdminLegalRequestsController],
  providers: [LegalRequestsService],
})
export class LegalRequestsModule {}
