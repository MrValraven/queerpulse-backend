import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AffiliationService } from './affiliation.service';
import { CompanyTeamMember } from '../companies/entities/company-team-member.entity';
import { Company } from '../companies/entities/company.entity';
import { SetAffiliationDto } from './dto/set-affiliation.dto';
import { Affiliation, AffiliationStatus } from './entities/affiliation.entity';

describe('AffiliationService', () => {
  let service: AffiliationService;
  let affiliations: {
    findOne: jest.Mock;
    create: jest.Mock;
    merge: jest.Mock;
    save: jest.Mock;
    delete: jest.Mock;
  };
  let companies: { findOne: jest.Mock };
  let team: { exists: jest.Mock };

  const now = new Date('2026-07-15T12:00:00.000Z');

  const company = (overrides: Partial<Company> = {}): Company =>
    ({
      id: 'company-1',
      slug: 'acme',
      nameText: 'Acme Co',
      ownerId: 'owner-1',
      ...overrides,
    }) as Company;

  const affiliationRow = (
    overrides: Partial<Affiliation> = {},
  ): Affiliation => ({
    id: 'aff-1',
    userId: 'u1',
    companyId: 'company-1',
    role: 'Engineer',
    status: AffiliationStatus.Pending,
    createdAt: now,
    ...overrides,
  });

  beforeEach(async () => {
    affiliations = {
      findOne: jest.fn(),
      create: jest.fn((v: Partial<Affiliation>) => v),
      merge: jest.fn((existing: Affiliation, v: Partial<Affiliation>) => ({
        ...existing,
        ...v,
      })),
      save: jest.fn((v: Partial<Affiliation>) =>
        Promise.resolve({ id: 'aff-1', createdAt: now, ...v }),
      ),
      delete: jest.fn(),
    };
    companies = { findOne: jest.fn() };
    team = { exists: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AffiliationService,
        { provide: getRepositoryToken(Affiliation), useValue: affiliations },
        { provide: getRepositoryToken(Company), useValue: companies },
        { provide: getRepositoryToken(CompanyTeamMember), useValue: team },
      ],
    }).compile();

    service = module.get(AffiliationService);
  });

  describe('myAffiliation', () => {
    it('returns null when the caller has no affiliation', async () => {
      affiliations.findOne.mockResolvedValue(null);
      await expect(service.myAffiliation('u1')).resolves.toBeNull();
      expect(companies.findOne).not.toHaveBeenCalled();
    });

    it('returns the EmployerAffiliationDTO shape when one exists', async () => {
      affiliations.findOne.mockResolvedValue(
        affiliationRow({ status: AffiliationStatus.Active, role: 'CTO' }),
      );
      companies.findOne.mockResolvedValue(company());

      const result = await service.myAffiliation('u1');

      expect(affiliations.findOne).toHaveBeenCalledWith({
        where: { userId: 'u1' },
      });
      expect(companies.findOne).toHaveBeenCalledWith({
        where: { id: 'company-1' },
      });
      expect(result).toEqual({
        companySlug: 'acme',
        company: { nameText: 'Acme Co' },
        role: 'CTO',
        status: 'active',
      });
    });

    it('throws NotFoundException when the affiliated company row is missing (data-integrity)', async () => {
      affiliations.findOne.mockResolvedValue(affiliationRow());
      companies.findOne.mockResolvedValue(null);

      await expect(service.myAffiliation('u1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('setAffiliation', () => {
    const dto: SetAffiliationDto = { companySlug: 'acme', role: 'Engineer' };

    it('throws NotFoundException when the company slug does not exist', async () => {
      companies.findOne.mockResolvedValue(null);
      await expect(service.setAffiliation('u1', dto)).rejects.toThrow(
        NotFoundException,
      );
      expect(affiliations.save).not.toHaveBeenCalled();
    });

    it('never derives status from the caller — always server-side', async () => {
      companies.findOne.mockResolvedValue(company({ ownerId: 'someone-else' }));
      team.exists.mockResolvedValue(false);
      affiliations.findOne.mockResolvedValue(null);

      await service.setAffiliation('u1', dto);

      expect(affiliations.create).toHaveBeenCalledWith(
        expect.objectContaining({ status: AffiliationStatus.Pending }),
      );
    });

    it('sets status active when the caller owns the company', async () => {
      companies.findOne.mockResolvedValue(company({ ownerId: 'u1' }));
      affiliations.findOne.mockResolvedValue(null);

      const result = await service.setAffiliation('u1', dto);

      expect(team.exists).not.toHaveBeenCalled();
      expect(result.status).toBe('active');
    });

    it('sets status active when the caller is a company_team_members roster member', async () => {
      companies.findOne.mockResolvedValue(company({ ownerId: 'owner-1' }));
      team.exists.mockResolvedValue(true);
      affiliations.findOne.mockResolvedValue(null);

      const result = await service.setAffiliation('u1', dto);

      expect(team.exists).toHaveBeenCalledWith({
        where: { companyId: 'company-1', userId: 'u1' },
      });
      expect(result.status).toBe('active');
    });

    it('sets status pending when the caller is neither owner nor team member', async () => {
      companies.findOne.mockResolvedValue(company({ ownerId: 'owner-1' }));
      team.exists.mockResolvedValue(false);
      affiliations.findOne.mockResolvedValue(null);

      const result = await service.setAffiliation('u1', dto);

      expect(result.status).toBe('pending');
    });

    it('creates a new row when the caller has no existing affiliation', async () => {
      companies.findOne.mockResolvedValue(company({ ownerId: 'u1' }));
      affiliations.findOne.mockResolvedValue(null);

      await service.setAffiliation('u1', dto);

      expect(affiliations.create).toHaveBeenCalledWith({
        userId: 'u1',
        companyId: 'company-1',
        role: 'Engineer',
        status: AffiliationStatus.Active,
      });
      expect(affiliations.merge).not.toHaveBeenCalled();
    });

    it('replaces (merges into) the existing row rather than adding a second — at most one per user', async () => {
      const otherCompany = company({
        id: 'company-2',
        slug: 'globex',
        nameText: 'Globex',
        ownerId: 'u1',
      });
      companies.findOne.mockResolvedValue(otherCompany);
      const existing = affiliationRow({ companyId: 'company-1' });
      affiliations.findOne.mockResolvedValue(existing);

      const result = await service.setAffiliation('u1', {
        companySlug: 'globex',
        role: 'Founder',
      });

      expect(affiliations.merge).toHaveBeenCalledWith(existing, {
        companyId: 'company-2',
        role: 'Founder',
        status: AffiliationStatus.Active,
      });
      expect(affiliations.create).not.toHaveBeenCalled();
      expect(result).toEqual({
        companySlug: 'globex',
        company: { nameText: 'Globex' },
        role: 'Founder',
        status: 'active',
      });
    });
  });

  describe('removeAffiliation', () => {
    it('deletes the caller row by userId', async () => {
      affiliations.delete.mockResolvedValue({ affected: 1 });
      await service.removeAffiliation('u1');
      expect(affiliations.delete).toHaveBeenCalledWith({ userId: 'u1' });
    });

    it('throws NotFoundException when the caller has no affiliation to remove', async () => {
      affiliations.delete.mockResolvedValue({ affected: 0 });
      await expect(service.removeAffiliation('u1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
