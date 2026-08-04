import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ContentModerationModule } from '../content-moderation/content-moderation.module';
import { CompanyOpenRolesService } from './company-open-roles.service';
import { Job } from './entities/job.entity';

/**
 * Standalone module exposing `CompanyOpenRolesService` — a read-only view of a
 * company's open roles over the `Job` repository alone. It imports neither
 * `CompaniesModule` nor `JobsModule`, so `CompaniesModule` can depend on it
 * one-directionally: this is what lets the Companies <-> Jobs `forwardRef`
 * cycle be removed entirely (mirrors `AffiliationModule`, which registers
 * `Company`/`CompanyTeamMember` read-only without importing `CompaniesModule`).
 *
 * Registering `Job` here via `forFeature` alongside `JobsModule`'s own
 * registration is fine — each module gets its own repository binding; the
 * entity itself is loaded once at the data-source level.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Job]), ContentModerationModule],
  providers: [CompanyOpenRolesService],
  exports: [CompanyOpenRolesService],
})
export class CompanyOpenRolesModule {}
