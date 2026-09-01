import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CompanyOpenRolesModule } from '../jobs/company-open-roles.module';
import { ContentModerationModule } from '../content-moderation/content-moderation.module';
import { SubmissionsModule } from '../submissions/submissions.module';
import { Profile } from '../users/entities/profile.entity';
import { UsersModule } from '../users/users.module';
import { CompaniesController } from './companies.controller';
import { CompaniesService } from './companies.service';
import { CompanyReview } from './entities/company-review.entity';
import { CompanyTeamMember } from './entities/company-team-member.entity';
import { Company } from './entities/company.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Company,
      CompanyTeamMember,
      CompanyReview,
      Profile,
    ]),
    UsersModule,
    // Open-role counts/lists for company cards + detail. `CompanyOpenRolesModule`
    // reads the `Job` repository only and imports neither `JobsModule` nor
    // `CompaniesModule`, so this is a one-directional dependency — the old
    // `forwardRef(() => JobsModule)` cycle is gone. (`JobsModule` still imports
    // `CompaniesModule`, but that edge no longer loops back here.)
    CompanyOpenRolesModule,
    // Read-only: lets public company reads (`list`/`getBySlug`/`listReviews`)
    // withhold a moderator-taken-down company, mirroring the directory's
    // takedown read-enforcement.
    ContentModerationModule,
    // `ReviewReplyNotifier` (PRD-48): the ONE place a "the subject of your
    // review answered it" bell row is written. Companies reach it through here
    // rather than importing `NotificationsModule` and inventing a
    // company-specific notification type, which is the per-vertical divergence
    // PRD-47 and PRD-48 are both about. `SubmissionsModule` holds no entity and
    // no controller and imports only `NotificationsModule`, so there is no
    // cycle back to companies.
    SubmissionsModule,
  ],
  controllers: [CompaniesController],
  providers: [CompaniesService],
  exports: [CompaniesService],
})
export class CompaniesModule {}
