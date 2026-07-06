import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JobsModule } from '../jobs/jobs.module';
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
    // Circular: `JobsModule` imports `CompaniesModule` (for `CompaniesService`)
    // and `CompaniesService` injects `JobsService` (for `getOpenRoles`) — see
    // `.superpowers/sdd/spec-phaseB-companies-jobs.md`'s Jobs section.
    forwardRef(() => JobsModule),
  ],
  controllers: [CompaniesController],
  providers: [CompaniesService],
  exports: [CompaniesService],
})
export class CompaniesModule {}
