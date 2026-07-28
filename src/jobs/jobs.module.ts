import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CompaniesModule } from '../companies/companies.module';
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
  ],
  controllers: [JobsController, MeApplicationsController],
  providers: [JobsService],
  exports: [JobsService],
})
export class JobsModule {}
