import { forwardRef, Module } from '@nestjs/common';
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
    // Circular: `CompaniesModule` imports `JobsModule` (for `JobsService`)
    // and `JobsService` injects `CompaniesService` (to resolve/authorize
    // companies and to create one inline) — see
    // `.superpowers/sdd/spec-phaseB-companies-jobs.md`'s Jobs section.
    forwardRef(() => CompaniesModule),
    UsersModule,
  ],
  controllers: [JobsController, MeApplicationsController],
  providers: [JobsService],
  exports: [JobsService],
})
export class JobsModule {}
