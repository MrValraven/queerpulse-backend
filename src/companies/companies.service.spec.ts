import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import {
  resetImageUrlBaseForTesting,
  setImageUrlBase,
} from '../common/image-url';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { ReviewReplyNotifier } from '../submissions/review-reply-notifier.service';
import { CompanyOpenRolesService } from '../jobs/company-open-roles.service';
import { Profile } from '../users/entities/profile.entity';
import { CompaniesService } from './companies.service';
import { CompanyReview } from './entities/company-review.entity';
import { CompanyTeamMember } from './entities/company-team-member.entity';
import { Company } from './entities/company.entity';

// A chainable query-builder stub whose terminal methods resolve to empty
// results by default (mirrors `communities.service.spec.ts`'s `qbStub`).
const qbStub = () => {
  const qb: Record<string, jest.Mock> = {};
  for (const m of [
    'select',
    'addSelect',
    'innerJoin',
    'leftJoin',
    'where',
    'andWhere',
    'groupBy',
    'orderBy',
    'skip',
    'take',
  ]) {
    qb[m] = jest.fn().mockReturnValue(qb);
  }
  qb.getMany = jest.fn().mockResolvedValue([]);
  qb.getRawMany = jest.fn().mockResolvedValue([]);
  qb.getManyAndCount = jest.fn().mockResolvedValue([[], 0]);
  return qb;
};

describe('CompaniesService', () => {
  let service: CompaniesService;
  let companies: {
    findOne: jest.Mock;
    exists: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let team: {
    find: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    exists: jest.Mock;
  };
  let reviews: {
    create: jest.Mock;
    findOne: jest.Mock;
    save: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  // The ONE shared review-reply bell (PRD-48). Stubbed rather than spied on the
  // real class so a test cannot accidentally depend on notification internals;
  // what matters here is that the reply path calls it with the reviewer, the
  // replying employer and the company's public name.
  let reviewReplyNotifier: { notifyReviewReplied: jest.Mock };
  let profiles: {
    findOne: jest.Mock;
    find: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let openRoles: {
    openRoleCountsForMany: jest.Mock;
    listForCompany: jest.Mock;
  };
  // Public reads (`getBySlug`) withhold a company under a moderator takedown;
  // by default nothing is taken down, so `stateFor` resolves "clean".
  let contentModeration: {
    stateFor: jest.Mock;
    statesFor: jest.Mock;
  };

  beforeEach(async () => {
    companies = {
      findOne: jest.fn(),
      exists: jest.fn().mockResolvedValue(false),
      create: jest.fn((v: object) => v),
      save: jest.fn((c: unknown) => Promise.resolve(c)),
      createQueryBuilder: jest.fn(() => qbStub()),
    };
    team = {
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn((v: object) => v),
      save: jest.fn((v: unknown) => Promise.resolve(v)),
      // A review author who is on the company's team is refused, the same way
      // the owner is. Default: the author is not on the team.
      exists: jest.fn().mockResolvedValue(false),
    };
    reviews = {
      create: jest.fn((v: object) => v),
      findOne: jest.fn().mockResolvedValue(null),
      // Synthesizes generated columns (`id`, `createdAt`) so a mapper reading
      // them off a `save()` result never sees `undefined` (the A4 lesson:
      // a bare-passthrough mock caused an `undefined.toISOString()` throw).
      save: jest.fn((v: unknown) =>
        Promise.resolve({
          id: 'review-id',
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          ...(v as object),
        }),
      ),
      createQueryBuilder: jest.fn(() => qbStub()),
    };
    profiles = {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
      createQueryBuilder: jest.fn(() => qbStub()),
    };
    // Open roles now come from `CompanyOpenRolesService` (Job-repo only, no
    // `JobsService`) — every test in this file exercises companies in
    // isolation, so counts/lists resolve empty unless a test says otherwise.
    openRoles = {
      openRoleCountsForMany: jest.fn().mockResolvedValue(new Map()),
      listForCompany: jest.fn().mockResolvedValue([]),
    };
    contentModeration = {
      stateFor: jest.fn().mockResolvedValue({ hidden: false, removed: false }),
      statesFor: jest.fn().mockResolvedValue(new Map()),
    };
    reviewReplyNotifier = {
      notifyReviewReplied: jest.fn().mockResolvedValue(undefined),
    };

    // `manager.getRepository(Entity)` routes to the same mocks the outer
    // `@InjectRepository` tokens use, so assertions work whether the code
    // path runs inside the transaction or not — mirrors
    // `communities.service.spec.ts`.
    const manager = {
      getRepository: jest.fn((entity: unknown) => {
        if (entity === Company) return companies;
        if (entity === CompanyTeamMember) return team;
        if (entity === Profile) return profiles;
        throw new Error(
          `unexpected entity in getRepository: ${String(entity)}`,
        );
      }),
    };
    const dataSource = {
      transaction: jest.fn(
        async (cb: (m: typeof manager) => Promise<unknown>) => cb(manager),
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CompaniesService,
        { provide: getRepositoryToken(Company), useValue: companies },
        { provide: getRepositoryToken(CompanyTeamMember), useValue: team },
        { provide: getRepositoryToken(CompanyReview), useValue: reviews },
        { provide: getRepositoryToken(Profile), useValue: profiles },
        { provide: DataSource, useValue: dataSource },
        { provide: CompanyOpenRolesService, useValue: openRoles },
        { provide: ContentModerationService, useValue: contentModeration },
        { provide: ReviewReplyNotifier, useValue: reviewReplyNotifier },
      ],
    }).compile();
    service = module.get(CompaniesService);
    // Mappers resolve stored image keys through `toImageUrl`, which throws
    // `Service temporarily unavailable` when the base was never wired. Only
    // storage-key fixtures reach it (the M1 foreign-upload cases).
    setImageUrlBase('https://api.test');
  });

  afterEach(() => {
    resetImageUrlBaseForTesting();
  });

  describe('create', () => {
    const baseDto = {
      nameText: 'Atelier Pulso',
      tagline: 'Design studio',
      about: 'We make things.',
      handle: 'atelier-pulso',
    };

    it('forces verified=false regardless of input, and sets ownerId/slug', async () => {
      companies.save.mockImplementation((c: Partial<Company>) => ({
        ...c,
        id: 'co-1',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      }));

      const res = await service.create('owner-1', {
        ...baseDto,
        // even if a caller somehow slipped this through, it's not read
      });

      expect(res.slug).toBe('atelier-pulso');
      expect(res.badges.verified).toBe(false);
      expect(companies.save).toHaveBeenCalledWith(
        expect.objectContaining({ verified: false, ownerId: 'owner-1' }),
      );
      expect(res.isOwner).toBe(true);
    });

    it('resolves team slugs via MemberLookup and seeds company_team_members rows, deduping the owner', async () => {
      companies.save.mockImplementation((c: Partial<Company>) => ({
        ...c,
        id: 'co-1',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      }));
      const qb = qbStub();
      qb.getMany!.mockResolvedValue([
        { slug: 'jo', userId: 'teammate-1' },
        { slug: 'owner-slug', userId: 'owner-1' }, // resolves to the owner -> deduped
      ]);
      profiles.createQueryBuilder.mockReturnValue(qb);

      await service.create('owner-1', {
        ...baseDto,
        team: ['jo', 'owner-slug'],
      });

      expect(team.save).toHaveBeenCalledWith([
        expect.objectContaining({ companyId: 'co-1', userId: 'teammate-1' }),
      ]);
      expect(companies.save).toHaveBeenCalledWith(
        expect.objectContaining({ teamCount: 1 }),
      );
    });
  });

  describe('getBySlug / review aggregates', () => {
    it('404s an unknown slug', async () => {
      companies.findOne.mockResolvedValue(null);
      await expect(service.getBySlug('nope', 'u1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('computes avg/count/bars correctly from raw review stars', async () => {
      companies.findOne.mockResolvedValue({
        id: 'co-1',
        slug: 'atelier-pulso',
        nameText: 'Atelier Pulso',
        tagline: 't',
        about: 'a',
        queerRun: true,
        queerLed: true,
        verified: false,
        values: [],
        info: [],
        teamCount: 0,
        hiringContact: null,
        work: [],
        ownerId: 'owner-1',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      });
      const qb = qbStub();
      qb.getRawMany!.mockResolvedValue([
        { companyId: 'co-1', stars: 5 },
        { companyId: 'co-1', stars: 5 },
        { companyId: 'co-1', stars: 3 },
        { companyId: 'co-1', stars: 1 },
      ]);
      reviews.createQueryBuilder.mockReturnValue(qb);

      const detail = await service.getBySlug('atelier-pulso', 'owner-1');

      expect(detail.reviewCount).toBe(4);
      expect(detail.reviewScore).toBeCloseTo((5 + 5 + 3 + 1) / 4);
      expect(detail.reviewBars).toEqual({
        one: 1,
        two: 0,
        three: 1,
        four: 0,
        five: 2,
      });
      expect(detail.isOwner).toBe(true);
      expect(detail.openRoles).toEqual([]);
      expect(detail.openRolesCount).toBe(0);
    });

    it('reports reviewScore=null with zero-filled bars when there are no reviews', async () => {
      companies.findOne.mockResolvedValue({
        id: 'co-2',
        slug: 'no-reviews',
        nameText: 'No Reviews Co',
        tagline: 't',
        about: 'a',
        queerRun: false,
        queerLed: false,
        verified: false,
        values: [],
        info: [],
        teamCount: 0,
        hiringContact: null,
        work: [],
        ownerId: 'owner-1',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      });

      const detail = await service.getBySlug('no-reviews', 'someone-else');

      expect(detail.reviewScore).toBeNull();
      expect(detail.reviewCount).toBe(0);
      expect(detail.isOwner).toBe(false);
    });
  });

  describe('update', () => {
    it('rejects a non-owner', async () => {
      companies.findOne.mockResolvedValue({
        id: 'co-1',
        slug: 'x',
        ownerId: 'owner-1',
      });
      await expect(
        service.update('x', 'intruder', { tagline: 'hijacked' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('persists a partial update for the owner', async () => {
      const company = {
        id: 'co-1',
        slug: 'x',
        nameText: 'Old Name',
        tagline: 'Old tagline',
        about: 'about',
        queerRun: false,
        queerLed: false,
        verified: false,
        values: [],
        info: [],
        teamCount: 0,
        hiringContact: null,
        work: [],
        ownerId: 'owner-1',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      };
      companies.findOne.mockResolvedValue(company);

      const res = await service.update('x', 'owner-1', {
        tagline: 'New tagline',
      });

      expect(res.tagline).toBe('New tagline');
      expect(companies.save).toHaveBeenCalledWith(
        expect.objectContaining({ tagline: 'New tagline' }),
      );
    });

    // Finding M1: `CompaniesController.update` keeps the interceptor's
    // foreign-upload exemption (co-managed company pages have more than one
    // editor), so the service is the line that stops a member introducing a
    // NEW work-item image that is not theirs while still letting a co-manager
    // re-save one a different collaborator uploaded.
    describe('foreign work-item image ownership (M1)', () => {
      const OWNER_ID = 'owner-1';
      const OTHER_ID = '22222222-2222-2222-2222-222222222222';
      const FILE_SEGMENT = '33333333-3333-3333-3333-333333333333';
      // A well-formed key whose embedded owner segment is NOT the requester.
      const FOREIGN_KEY = `work/${OTHER_ID}/${FILE_SEGMENT}.jpg`;

      const makeCompany = (
        work: { label: string; imageUrl: string | null }[],
      ) => ({
        id: 'co-1',
        slug: 'x',
        nameText: 'Name',
        tagline: 'tagline',
        about: 'about',
        queerRun: false,
        queerLed: false,
        verified: false,
        values: [],
        info: [],
        teamCount: 0,
        hiringContact: null,
        work,
        ownerId: OWNER_ID,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      });

      it('allows re-saving a work-item image the company already carries', async () => {
        companies.findOne.mockResolvedValue(
          makeCompany([{ label: 'Old', imageUrl: FOREIGN_KEY }]),
        );
        await expect(
          service.update('x', OWNER_ID, {
            work: [{ label: 'Renamed', imageUrl: FOREIGN_KEY }],
          }),
        ).resolves.toBeDefined();
      });

      it('rejects a new foreign work-item image the company does not carry', async () => {
        companies.findOne.mockResolvedValue(makeCompany([]));
        await expect(
          service.update('x', OWNER_ID, {
            work: [{ label: 'New', imageUrl: FOREIGN_KEY }],
          }),
        ).rejects.toBeInstanceOf(ForbiddenException);
      });
    });
  });

  describe('createReview', () => {
    it('maps a duplicate (company, author) review to 409 Conflict', async () => {
      companies.findOne.mockResolvedValue({ id: 'co-1', slug: 'x' });
      reviews.save.mockRejectedValueOnce({ code: '23505' });

      await expect(
        service.createReview('x', 'author-1', {
          title: 'Great place',
          stars: 5,
          byline: 'Former employee',
          body: ['Loved it'],
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('creates a review and resolves the author MemberRef', async () => {
      companies.findOne.mockResolvedValue({ id: 'co-1', slug: 'x' });
      profiles.find.mockResolvedValue([
        {
          userId: 'author-1',
          slug: 'jo',
          firstName: 'Jo',
          lastName: 'D',
          avatarUrl: null,
        },
      ]);

      const res = await service.createReview('x', 'author-1', {
        title: 'Great place',
        stars: 5,
        byline: 'Former employee',
        body: ['Loved it'],
      });

      expect(res.stars).toBe(5);
      expect(res.author?.slug).toBe('jo');
    });
  });
  // PRD-47: the employer's right of reply, and what a later edit by the
  // reviewer may and may not do to it.
  describe('replyToReview', () => {
    const claimed = {
      id: 'co-1',
      slug: 'x',
      nameText: 'Atelier Pulso',
      ownerId: 'owner-1',
    };

    /** A stored review with no reply and no edit yet. */
    const freshReview = () => ({
      id: '11111111-1111-4111-8111-111111111111',
      companyId: 'co-1',
      authorId: 'author-1',
      title: 'Good place, slow payroll',
      stars: 4,
      byline: 'Former employee',
      body: ['Payroll was late twice.'],
      ownerReplyText: null as string | null,
      ownerRepliedAt: null as Date | null,
      editedAt: null as Date | null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    it('refuses a reply on an UNCLAIMED company: nobody is entitled to answer', async () => {
      companies.findOne.mockResolvedValue({ ...claimed, ownerId: null });

      await expect(
        service.replyToReview('x', 'someone-1', freshReview().id, {
          text: 'We fixed it.',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(reviews.findOne).not.toHaveBeenCalled();
    });

    it('refuses a reply from a member who is not the owner', async () => {
      companies.findOne.mockResolvedValue(claimed);

      await expect(
        service.replyToReview('x', 'not-the-owner', freshReview().id, {
          text: 'We fixed it.',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('404s a review id that belongs to another company', async () => {
      companies.findOne.mockResolvedValue(claimed);
      reviews.findOne.mockResolvedValue(null);

      await expect(
        service.replyToReview('x', 'owner-1', freshReview().id, {
          text: 'We fixed it.',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
      // Scoped to THIS company, so a guessed id cannot reach another
      // employer's review.
      expect(reviews.findOne).toHaveBeenCalledWith({
        where: { id: freshReview().id, companyId: 'co-1' },
      });
    });

    it('refuses a whitespace-only reply, which would strand a timestamp with nothing on screen', async () => {
      companies.findOne.mockResolvedValue(claimed);
      reviews.findOne.mockResolvedValue(freshReview());

      await expect(
        service.replyToReview('x', 'owner-1', freshReview().id, {
          text: '   ',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(reviews.save).not.toHaveBeenCalled();
    });

    it('stores the trimmed reply, stamps ownerRepliedAt and returns it on the DTO', async () => {
      companies.findOne.mockResolvedValue(claimed);
      reviews.findOne.mockResolvedValue(freshReview());

      const dto = await service.replyToReview(
        'x',
        'owner-1',
        freshReview().id,
        {
          text: '  Payroll moved to the 25th in March.  ',
        },
      );

      expect(reviews.save).toHaveBeenCalledWith(
        expect.objectContaining({
          ownerReplyText: 'Payroll moved to the 25th in March.',
          ownerRepliedAt: expect.any(Date) as unknown,
        }),
      );
      expect(dto.ownerReply?.text).toBe('Payroll moved to the 25th in March.');
      expect(dto.isEditedAfterOwnerReply).toBe(false);
    });

    it('overwrites an existing reply rather than threading a second one', async () => {
      companies.findOne.mockResolvedValue(claimed);
      reviews.findOne.mockResolvedValue({
        ...freshReview(),
        ownerReplyText: 'Old reply',
        ownerRepliedAt: new Date('2026-02-01T00:00:00.000Z'),
      });

      const dto = await service.replyToReview(
        'x',
        'owner-1',
        freshReview().id,
        {
          text: 'Corrected reply',
        },
      );

      expect(dto.ownerReply?.text).toBe('Corrected reply');
    });

    it('notifies the reviewer through the shared notifier, naming the employer and never the reply text', async () => {
      companies.findOne.mockResolvedValue(claimed);
      reviews.findOne.mockResolvedValue(freshReview());

      await service.replyToReview('x', 'owner-1', freshReview().id, {
        text: 'Payroll moved to the 25th.',
      });

      expect(reviewReplyNotifier.notifyReviewReplied).toHaveBeenCalledWith({
        reviewAuthorId: 'author-1',
        replyingSubjectId: 'owner-1',
        subjectLabel: 'Atelier Pulso',
      });
    });
  });

  describe('updateReview', () => {
    const company = {
      id: 'co-1',
      slug: 'x',
      nameText: 'Atelier Pulso',
      ownerId: 'owner-1',
    };
    const repliedReview = () => ({
      id: '22222222-2222-4222-8222-222222222222',
      companyId: 'co-1',
      authorId: 'author-1',
      title: 'Good place, slow payroll',
      stars: 4,
      byline: 'Former employee',
      body: ['Payroll was late twice.'],
      ownerReplyText: 'Payroll moved to the 25th.',
      ownerRepliedAt: new Date('2026-02-01T00:00:00.000Z'),
      editedAt: null as Date | null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    it("refuses to edit somebody else's review", async () => {
      companies.findOne.mockResolvedValue(company);
      reviews.findOne.mockResolvedValue(repliedReview());

      await expect(
        service.updateReview('x', repliedReview().id, 'not-the-author', {
          title: 'Rewritten',
          stars: 1,
          byline: 'Former employee',
          body: ['Different words.'],
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('KEEPS the employer reply on edit: an edit is never a delete button for it', async () => {
      companies.findOne.mockResolvedValue(company);
      reviews.findOne.mockResolvedValue(repliedReview());

      const dto = await service.updateReview(
        'x',
        repliedReview().id,
        'author-1',
        {
          title: 'Good place, slow payroll',
          stars: 2,
          byline: 'Former employee',
          body: ['Payroll was late four times, not twice.'],
        },
      );

      expect(reviews.save).toHaveBeenCalledWith(
        expect.objectContaining({
          ownerReplyText: 'Payroll moved to the 25th.',
          ownerRepliedAt: new Date('2026-02-01T00:00:00.000Z'),
        }),
      );
      expect(dto.ownerReply?.text).toBe('Payroll moved to the 25th.');
    });

    it('flags isEditedAfterOwnerReply when the words change after the reply went up', async () => {
      companies.findOne.mockResolvedValue(company);
      reviews.findOne.mockResolvedValue(repliedReview());

      const dto = await service.updateReview(
        'x',
        repliedReview().id,
        'author-1',
        {
          title: 'Good place, slow payroll',
          stars: 1,
          byline: 'Former employee',
          body: ['Payroll was late every single month.'],
        },
      );

      expect(dto.editedAt).not.toBeNull();
      expect(dto.isEditedAfterOwnerReply).toBe(true);
    });

    it('does NOT stamp an edit when nothing actually changed, so an identical re-save cannot manufacture the flag', async () => {
      companies.findOne.mockResolvedValue(company);
      reviews.findOne.mockResolvedValue(repliedReview());

      const dto = await service.updateReview(
        'x',
        repliedReview().id,
        'author-1',
        {
          title: 'Good place, slow payroll',
          stars: 4,
          byline: 'Former employee',
          body: ['Payroll was late twice.'],
        },
      );

      expect(dto.editedAt).toBeNull();
      expect(dto.isEditedAfterOwnerReply).toBe(false);
      expect(dto.ownerReply?.text).toBe('Payroll moved to the 25th.');
    });

    it('refuses an edit that empties the review', async () => {
      companies.findOne.mockResolvedValue(company);
      reviews.findOne.mockResolvedValue(repliedReview());

      await expect(
        service.updateReview('x', repliedReview().id, 'author-1', {
          title: '   ',
          stars: 3,
          byline: 'Former employee',
          body: ['   '],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(reviews.save).not.toHaveBeenCalled();
    });
  });
});
