import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CompanyTeamMember } from '../companies/entities/company-team-member.entity';
import { Company } from '../companies/entities/company.entity';
import {
  EmployerAffiliationDTO,
  toEmployerAffiliationDTO,
} from './affiliation-response';
import { SetAffiliationDto } from './dto/set-affiliation.dto';
import { Affiliation, AffiliationStatus } from './entities/affiliation.entity';

/**
 * The caller's own employer affiliation (plan Task 2.4; spec §3 Tier 2
 * "affiliation"). Reads `Company`/`CompanyTeamMember` directly — imported
 * read-only, no `CompaniesModule`/`CompaniesService` dependency — to resolve
 * `companySlug` and to derive `status`.
 */
@Injectable()
export class AffiliationService {
  constructor(
    @InjectRepository(Affiliation)
    private readonly affiliations: Repository<Affiliation>,
    @InjectRepository(Company)
    private readonly companies: Repository<Company>,
    @InjectRepository(CompanyTeamMember)
    private readonly team: Repository<CompanyTeamMember>,
  ) {}

  /** The caller's current affiliation, or `null` if they have none. */
  async myAffiliation(userId: string): Promise<EmployerAffiliationDTO | null> {
    const affiliation = await this.affiliations.findOne({ where: { userId } });
    if (!affiliation) return null;

    const company = await this.companies.findOne({
      where: { id: affiliation.companyId },
    });
    if (!company) {
      // FK (`affiliations.company_id` -> `companies.id`, ON DELETE CASCADE)
      // means this row can't outlive its company — a miss here would be a
      // data-integrity bug, not a legitimate empty state.
      throw new NotFoundException('Company not found for affiliation');
    }

    return toEmployerAffiliationDTO(affiliation, company);
  }

  /**
   * Sets (or replaces) the caller's affiliation — at most one per user.
   * `status` is derived, never caller-supplied: `active` when the caller
   * already owns the company or is on its `company_team_members` roster (the
   * same test `CompaniesService#getCompanyForJobPosting` uses to authorize
   * job posting), `pending` otherwise — mirroring the FE's own comment
   * ("starts pending ... then flips to active").
   */
  async setAffiliation(
    userId: string,
    dto: SetAffiliationDto,
  ): Promise<EmployerAffiliationDTO> {
    const company = await this.companies.findOne({
      where: { slug: dto.companySlug },
    });
    if (!company) {
      throw new NotFoundException('Company not found');
    }

    const status = await this.deriveStatus(userId, company);
    const existing = await this.affiliations.findOne({ where: { userId } });

    const toSave = existing
      ? this.affiliations.merge(existing, {
          companyId: company.id,
          role: dto.role,
          status,
        })
      : this.affiliations.create({
          userId,
          companyId: company.id,
          role: dto.role,
          status,
        });

    const saved = await this.affiliations.save(toSave);
    return toEmployerAffiliationDTO(saved, company);
  }

  /** Drops the caller's affiliation entirely. 404 if they have none. */
  async removeAffiliation(userId: string): Promise<void> {
    const result = await this.affiliations.delete({ userId });
    if (!result.affected) {
      throw new NotFoundException('Affiliation not found');
    }
  }

  private async deriveStatus(
    userId: string,
    company: Company,
  ): Promise<AffiliationStatus> {
    if (company.ownerId === userId) return AffiliationStatus.Active;

    const isTeamMember = await this.team.exists({
      where: { companyId: company.id, userId },
    });
    return isTeamMember ? AffiliationStatus.Active : AffiliationStatus.Pending;
  }
}
