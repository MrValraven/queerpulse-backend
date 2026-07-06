import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { CompaniesService } from '../companies/companies.service';
import { Profile } from '../users/entities/profile.entity';
import {
  JobApplication,
  JobApplicationStatus,
} from './entities/job-application.entity';
import { Job, JobFormat, JobStatus } from './entities/job.entity';
import { JobsService } from './jobs.service';

// A chainable query-builder stub whose terminal methods resolve to empty
// results by default (mirrors `companies.service.spec.ts`'s `qbStub`).
const qbStub = () => {
  const qb: Record<string, jest.Mock> = {};
  for (const m of ['where', 'andWhere', 'orderBy', 'skip', 'take']) {
    qb[m] = jest.fn().mockReturnValue(qb);
  }
  qb.getManyAndCount = jest.fn().mockResolvedValue([[], 0]);
  return qb;
};

describe('JobsService', () => {
  let service: JobsService;
  let jobs: {
    findOne: jest.Mock;
    exists: jest.Mock;
    find: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let applications: {
    findOne: jest.Mock;
    find: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  let profiles: {
    findOne: jest.Mock;
    find: jest.Mock;
  };
  let companiesService: {
    create: jest.Mock;
    getCompanyForJobPosting: jest.Mock;
    companyRefsByIds: jest.Mock;
  };

  const baseJobDto = {
    title: 'Backend Engineer',
    category: 'Engineering',
    commitment: 'Full-time',
    seniority: 'Mid',
    format: JobFormat.Remote,
    location: 'Remote',
    description: 'Build things.',
    agreement: true,
  };

  beforeEach(async () => {
    jobs = {
      findOne: jest.fn(),
      exists: jest.fn().mockResolvedValue(false),
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn((v: object) => v),
      // Synthesizes generated columns so a mapper reading them off a
      // `save()` result never sees `undefined` (the A4 lesson, mirrored from
      // `companies.service.spec.ts`).
      save: jest.fn((j: unknown) =>
        Promise.resolve({
          id: 'job-1',
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          updatedAt: new Date('2026-01-01T00:00:00.000Z'),
          ...(j as object),
        }),
      ),
      createQueryBuilder: jest.fn(() => qbStub()),
    };
    applications = {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn((v: object) => v),
      save: jest.fn((v: unknown) =>
        Promise.resolve({
          id: 'app-1',
          status: JobApplicationStatus.Submitted,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          ...(v as object),
        }),
      ),
    };
    profiles = {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
    };
    companiesService = {
      create: jest.fn(),
      getCompanyForJobPosting: jest.fn(),
      companyRefsByIds: jest.fn().mockResolvedValue(new Map()),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JobsService,
        { provide: getRepositoryToken(Job), useValue: jobs },
        {
          provide: getRepositoryToken(JobApplication),
          useValue: applications,
        },
        { provide: getRepositoryToken(Profile), useValue: profiles },
        { provide: CompaniesService, useValue: companiesService },
      ],
    }).compile();
    service = module.get(JobsService);
  });

  describe('create', () => {
    it('rejects a poster who is neither the company owner nor on its team (403)', async () => {
      companiesService.getCompanyForJobPosting.mockRejectedValue(
        new ForbiddenException(
          'Only the company owner or team can post jobs for this company',
        ),
      );

      await expect(
        service.create('intruder', {
          ...baseJobDto,
          companySlug: 'atelier-pulso',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(jobs.save).not.toHaveBeenCalled();
    });

    it('inline-creates a company when companySlug is omitted and company is provided', async () => {
      companiesService.create.mockResolvedValue({
        slug: 'new-co',
        nameText: 'New Co',
      });
      companiesService.getCompanyForJobPosting.mockResolvedValue({
        id: 'co-1',
        slug: 'new-co',
        nameText: 'New Co',
      });
      companiesService.companyRefsByIds.mockResolvedValue(
        new Map([['co-1', { slug: 'new-co', nameText: 'New Co' }]]),
      );

      const res = await service.create('owner-1', {
        ...baseJobDto,
        company: { nameText: 'New Co', tagline: 't', about: 'a' },
      });

      expect(companiesService.create).toHaveBeenCalledWith('owner-1', {
        nameText: 'New Co',
        tagline: 't',
        about: 'a',
      });
      expect(jobs.save).toHaveBeenCalledWith(
        expect.objectContaining({
          companyId: 'co-1',
          title: 'Backend Engineer',
        }),
      );
      expect(res.company).toEqual({ slug: 'new-co', nameText: 'New Co' });
    });

    it('rejects when neither companySlug nor company is provided', async () => {
      await expect(
        service.create('owner-1', { ...baseJobDto }),
      ).rejects.toThrow();
      expect(companiesService.getCompanyForJobPosting).not.toHaveBeenCalled();
    });
  });

  describe('getBySlug', () => {
    it('404s an unknown slug', async () => {
      jobs.findOne.mockResolvedValue(null);
      await expect(service.getBySlug('nope', 'u1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('update', () => {
    it('rejects a non-poster', async () => {
      jobs.findOne.mockResolvedValue({
        id: 'job-1',
        slug: 'x',
        posterId: 'poster-1',
      });
      await expect(
        service.update('x', 'intruder', { title: 'Hijacked title' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('apply', () => {
    it('maps a duplicate (job, applicant) application to 409 Conflict', async () => {
      jobs.findOne.mockResolvedValue({
        id: 'job-1',
        slug: 'backend-engineer',
        title: 'Backend Engineer',
      });
      applications.save.mockRejectedValueOnce({ code: '23505' });

      await expect(
        service.apply('backend-engineer', 'applicant-1', {
          answers: [{ question: 'Why?', answer: 'Because.' }],
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('creates an application and resolves the applicant MemberRef', async () => {
      jobs.findOne.mockResolvedValue({
        id: 'job-1',
        slug: 'backend-engineer',
        title: 'Backend Engineer',
      });
      profiles.find.mockResolvedValue([
        {
          userId: 'applicant-1',
          slug: 'jo',
          firstName: 'Jo',
          lastName: 'D',
          avatarUrl: null,
        },
      ]);

      const res = await service.apply('backend-engineer', 'applicant-1', {
        answers: [{ question: 'Why?', answer: 'Because.' }],
        coverNote: 'Excited to apply.',
      });

      expect(res.applicant?.slug).toBe('jo');
      expect(res.job).toEqual({
        slug: 'backend-engineer',
        title: 'Backend Engineer',
      });
      expect(res.status).toBe(JobApplicationStatus.Submitted);
    });
  });

  describe('listApplications', () => {
    it('rejects a non-poster (403)', async () => {
      jobs.findOne.mockResolvedValue({
        id: 'job-1',
        slug: 'x',
        posterId: 'poster-1',
      });
      await expect(
        service.listApplications('x', 'intruder'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('lists applications for the poster', async () => {
      jobs.findOne.mockResolvedValue({
        id: 'job-1',
        slug: 'x',
        title: 'Backend Engineer',
        posterId: 'poster-1',
      });
      applications.find.mockResolvedValue([
        {
          id: 'app-1',
          jobId: 'job-1',
          applicantId: 'applicant-1',
          answers: [],
          coverNote: null,
          status: JobApplicationStatus.Submitted,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
        },
      ]);
      profiles.find.mockResolvedValue([
        {
          userId: 'applicant-1',
          slug: 'jo',
          firstName: 'Jo',
          lastName: 'D',
          avatarUrl: null,
        },
      ]);

      const res = await service.listApplications('x', 'poster-1');

      expect(res).toHaveLength(1);
      expect(res[0].applicant?.slug).toBe('jo');
    });
  });

  describe('listOpenForCompany', () => {
    it('filters to open jobs and maps them to JobCardDTO', async () => {
      jobs.find.mockResolvedValue([
        {
          id: 'job-1',
          slug: 'a',
          companyId: 'co-1',
          title: 'A',
          category: 'c',
          commitment: 'ft',
          seniority: 's',
          format: JobFormat.Remote,
          location: 'l',
          city: null,
          timezone: null,
          salary: null,
          rateMin: null,
          rateMax: null,
          currency: null,
          ratePer: null,
          hidePay: false,
          barter: false,
          deadline: null,
          startDate: null,
          desc: 'd',
          tags: [],
          queerRun: false,
          qrLabel: null,
          status: JobStatus.Open,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
        },
      ]);
      companiesService.companyRefsByIds.mockResolvedValue(
        new Map([
          ['co-1', { slug: 'atelier-pulso', nameText: 'Atelier Pulso' }],
        ]),
      );

      const res = await service.listOpenForCompany('co-1');

      expect(jobs.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { companyId: 'co-1', status: JobStatus.Open },
        }),
      );
      expect(res).toHaveLength(1);
      expect(res[0].company).toEqual({
        slug: 'atelier-pulso',
        nameText: 'Atelier Pulso',
      });
      expect(res[0].status).toBe(JobStatus.Open);
    });

    it('returns [] without calling companyRefsByIds when there are no open jobs', async () => {
      jobs.find.mockResolvedValue([]);

      const res = await service.listOpenForCompany('co-empty');

      expect(res).toEqual([]);
      expect(companiesService.companyRefsByIds).not.toHaveBeenCalled();
    });
  });
});
