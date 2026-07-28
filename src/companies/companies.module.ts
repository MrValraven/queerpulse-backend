import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CompanyOpenRolesModule } from '../jobs/company-open-roles.module';
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
  ],
  controllers: [CompaniesController],
  providers: [CompaniesService],
  exports: [CompaniesService],
})
export class CompaniesModule {}
