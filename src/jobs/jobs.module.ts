import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CompaniesModule } from '../companies/companies.module';
import { ContentModerationModule } from '../content-moderation/content-moderation.module';
import { MessagingModule } from '../messaging/messaging.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { Profile } from '../users/entities/profile.entity';
import { UsersModule } from '../users/users.module';
import { JobApplication } from './entities/job-application.entity';
import { Job } from './entities/job.entity';
import { JobsController, MeApplicationsController } from './jobs.controller';
import { JobsService } from './jobs.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Job, JobApplication, Profile]),
    // `JobsService` injects `CompaniesService` (resolve/authorize a company for
    // posting, inline-create one, batch-resolve company refs). This is now a
    // one-directional import: `CompaniesModule` no longer imports `JobsModule`
    // (it depends on the standalone `CompanyOpenRolesModule` for open roles),
    // so the old `forwardRef` cycle is gone.
    CompaniesModule,
    UsersModule,
    // `NotificationsService` — tell the job's poster when someone applies.
    NotificationsModule,
    // `MessagingService` — deliver the poster's decision on an application to
    // the applicant (BE-HSG-16). Mirrors `ListingsModule`/`HousingListingsModule`,
    // which use the same seam for moderation and enquiry delivery.
    MessagingModule,
    // `ContentModerationService` — read `job` takedown state so a
    // moderator-removed job is withheld from members' read paths.
    ContentModerationModule,
  ],
  controllers: [JobsController, MeApplicationsController],
  providers: [JobsService],
  exports: [JobsService],
})
export class JobsModule {}
