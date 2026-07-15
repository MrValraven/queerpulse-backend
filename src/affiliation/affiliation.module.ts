import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CompanyTeamMember } from '../companies/entities/company-team-member.entity';
import { Company } from '../companies/entities/company.entity';
import { AffiliationController } from './affiliation.controller';
import { AffiliationService } from './affiliation.service';
import { Affiliation } from './entities/affiliation.entity';

/**
 * `src/affiliation` — plan Task 2.4; spec §3 Tier 2 "affiliation". Imports
 * `Company`/`CompanyTeamMember` read-only (no `CompaniesModule` import) to
 * resolve `companySlug` and derive `status`; never writes to either table and
 * does not otherwise touch `src/companies`, per the coordination protocol.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Affiliation, Company, CompanyTeamMember]),
  ],
  controllers: [AffiliationController],
  providers: [AffiliationService],
  exports: [AffiliationService],
})
export class AffiliationModule {}
