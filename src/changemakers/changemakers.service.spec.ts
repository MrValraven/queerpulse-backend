import { ConflictException, ForbiddenException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ChangemakersService } from './changemakers.service';
import { Changemaker, ChangemakerStatus } from './entities/changemaker.entity';
import { ChangemakerDirectorySettings } from './entities/changemaker-directory-settings.entity';
import { CreateChangemakerDto } from './dto/create-changemaker.dto';
import { UpdateChangemakerDto } from './dto/update-changemaker.dto';

function buildProfile(overrides: Partial<Changemaker> = {}): Changemaker {
  return {
    id: 'id-1',
    slug: 'ada-lovelace',
    name: 'Ada Lovelace',
    initials: 'AL',
    cause: 'Housing',
    tint: 'jade',
    tags: [],
    summary: 'Summary',
    imageUrl: null,
    impact: [],
    byline: '',
    heroNote: '',
    lead: '',
    body: [],
    pullQuoteText: '',
    pullQuoteCite: '',
    status: ChangemakerStatus.Published,
    isFeatured: false,
    sortOrder: 0,
    publishedAt: new Date('2026-01-01T00:00:00Z'),
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

// The published-totals aggregate's query-builder stub: chainable, resolving
// to "nothing published" by default. Tests that assert on the totals override
// `getRawOne`.
// Declared with the exact method shape (rather than a `Record<string,
// jest.Mock>` index signature) so `totalsQb.getRawOne.mockResolvedValue(...)`
// doesn't see `noUncheckedIndexedAccess`'s `| undefined`.
type TotalsQueryBuilderStub = {
  select: jest.Mock;
  addSelect: jest.Mock;
  where: jest.Mock;
  getRawOne: jest.Mock;
};

const totalsQbStub = (): TotalsQueryBuilderStub => {
  const qb: TotalsQueryBuilderStub = {
    select: jest.fn(),
    addSelect: jest.fn(),
    where: jest.fn(),
    getRawOne: jest.fn().mockResolvedValue({ profiled: '0', causeAreas: '0' }),
  };
  qb.select.mockReturnValue(qb);
  qb.addSelect.mockReturnValue(qb);
  qb.where.mockReturnValue(qb);
  return qb;
};

describe('ChangemakersService', () => {
  let service: ChangemakersService;
  const changemakerRepo = {
    find: jest.fn(),
    findOne: jest.fn(),
    create: jest.fn((value: Partial<Changemaker>) => value),
    save: jest.fn((value: Changemaker) => Promise.resolve(value)),
    remove: jest.fn(),
    // Used by `allocateUniqueSlug`'s exists-checker inside
    // `createWithUniqueSlug`.
    exists: jest.fn(),
    // `profiled` / `causeAreas` are aggregated in SQL (COUNT + COUNT
    // DISTINCT) rather than derived from the fetched rows.
    createQueryBuilder: jest.fn(() => totalsQbStub()),
  };
  const settingsRepo = {
    findOne: jest.fn(),
    create: jest.fn((value: Partial<ChangemakerDirectorySettings>) => value),
    save: jest.fn((value: ChangemakerDirectorySettings) => value),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    // `create()`'s tests below need a fully-shaped `Changemaker` (with
    // `id`/`createdAt`/`updatedAt`) coming back out of `.create()` so
    // `toChangemakerDTO` has something to call `.toISOString()` on — the two
    // existing tests above never call `.create()`, so this is a no-op for
    // them.
    changemakerRepo.create.mockImplementation((value: Partial<Changemaker>) =>
      buildProfile(value),
    );
    // Reset `.save()` to identity every test — `jest.clearAllMocks()` above
    // clears call history but NOT a previously-set `mockImplementation`/
    // `mockRejectedValue`, so without this reset a persistent rejection set
    // by one `create()` retry test (e.g. "gives up ... after exhausting slug
    // attempts") would silently leak into every later test's `.save()` call,
    // including the unrelated `update()` tests below. Tests that need
    // call-specific behavior (`mockRejectedValueOnce`/`mockImplementationOnce`)
    // still take priority over this default for their queued calls.
    changemakerRepo.save.mockImplementation((value: Changemaker) =>
      Promise.resolve(value),
    );
    const moduleRef = await Test.createTestingModule({
      providers: [
        ChangemakersService,
        { provide: getRepositoryToken(Changemaker), useValue: changemakerRepo },
        {
          provide: getRepositoryToken(ChangemakerDirectorySettings),
          useValue: settingsRepo,
        },
      ],
    }).compile();
    service = moduleRef.get(ChangemakersService);
  });

  it('computes profiled + distinct causeAreas from published profiles', async () => {
    changemakerRepo.find.mockResolvedValue([
      buildProfile({ id: 'a', cause: 'Housing' }),
      buildProfile({ id: 'b', cause: 'housing' }),
      buildProfile({ id: 'c', cause: 'Climate' }),
    ]);
    settingsRepo.findOne.mockResolvedValue({
      id: 'default',
      peopleHelped: 1200,
      activeCampaigns: 12,
    });

    // The totals are counted in SQL over the published set, not derived from
    // the rows fetched above: three profiles, two distinct causes once
    // "Housing"/"housing" are folded together.
    const totalsQb = totalsQbStub();
    totalsQb.getRawOne.mockResolvedValue({ profiled: '3', causeAreas: '2' });
    changemakerRepo.createQueryBuilder.mockReturnValue(totalsQb);

    const result = await service.listPublic();

    expect(result.stats.profiled).toBe(3);
    expect(result.stats.causeAreas).toBe(2);
    expect(result.stats.peopleHelped).toBe(1200);
    expect(result.stats.activeCampaigns).toBe(12);
  });

  it('setPublished(true) stamps publishedAt and status', async () => {
    const draft = buildProfile({
      status: ChangemakerStatus.Draft,
      publishedAt: null,
    });
    changemakerRepo.findOne.mockResolvedValue(draft);

    const result = await service.setPublished('id-1', true);

    expect(result.status).toBe('published');
    expect(result.publishedAt).not.toBeNull();
  });

  const baseCreateDto: CreateChangemakerDto = {
    name: 'Ada Lovelace',
    initials: 'AL',
    cause: 'Housing',
    tint: 'jade',
    tags: [],
    summary: 's',
    impact: [],
  };

  it('create() allocates a slug from the name and saves a draft profile', async () => {
    changemakerRepo.exists.mockResolvedValue(false);

    const result = await service.create('admin-1', baseCreateDto);

    expect(result.slug).toBe('ada-lovelace');
    expect(result.status).toBe('draft');
    expect(result.publishedAt).toBeNull();
    expect(changemakerRepo.save).toHaveBeenCalledTimes(1);
  });

  it('create() retries with a fresh slug when save races a concurrent insert (23505)', async () => {
    changemakerRepo.exists.mockResolvedValue(false);
    changemakerRepo.save
      .mockRejectedValueOnce({ code: '23505' })
      .mockImplementationOnce((value: Changemaker) => Promise.resolve(value));

    const result = await service.create('admin-1', baseCreateDto);

    expect(result.slug).toBe('ada-lovelace');
    expect(changemakerRepo.save).toHaveBeenCalledTimes(2);
  });

  it('create() gives up with a ConflictException after exhausting slug attempts', async () => {
    changemakerRepo.exists.mockResolvedValue(false);
    changemakerRepo.save.mockRejectedValue({ code: '23505' });

    await expect(
      service.create('admin-1', baseCreateDto),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(changemakerRepo.save).toHaveBeenCalledTimes(5);
  });

  it('create() rethrows a non-unique-violation error without retrying', async () => {
    changemakerRepo.exists.mockResolvedValue(false);
    const boom = new Error('boom');
    changemakerRepo.save.mockRejectedValueOnce(boom);

    await expect(service.create('admin-1', baseCreateDto)).rejects.toBe(boom);
    expect(changemakerRepo.save).toHaveBeenCalledTimes(1);
  });

  it('update() applies the patch and preserves untouched fields', async () => {
    const existing = buildProfile({
      name: 'Ada Lovelace',
      cause: 'Housing',
      summary: 'Old summary',
    });
    changemakerRepo.findOne.mockResolvedValue(existing);

    const result = await service.update('admin-1', 'id-1', {
      summary: 'new summary',
      cause: 'Climate',
    });

    expect(result.summary).toBe('new summary');
    expect(result.cause).toBe('Climate');
    expect(result.name).toBe('Ada Lovelace');
  });

  it('update() sets imageUrl to null when explicitly cleared, and leaves it untouched when omitted', async () => {
    changemakerRepo.findOne.mockResolvedValue(
      buildProfile({ imageUrl: 'https://example.com/old.jpg' }),
    );
    // The DTO's compile-time type is `imageUrl?: string` (no `null`), but
    // `@IsOptional()` on `@IsString()` lets a request body's literal `null`
    // through validation untouched — this cast models that real runtime
    // shape so `Object.assign(profile, dto)` is exercised the same way a
    // live request would.
    const clearImageUrl = {
      imageUrl: null,
    } as unknown as UpdateChangemakerDto;

    const cleared = await service.update('admin-1', 'id-1', clearImageUrl);

    expect(cleared.imageUrl).toBeNull();

    changemakerRepo.findOne.mockResolvedValue(
      buildProfile({ imageUrl: 'https://example.com/old.jpg' }),
    );

    const untouched = await service.update('admin-1', 'id-1', {
      summary: 'unrelated change',
    });

    expect(untouched.imageUrl).toBe('https://example.com/old.jpg');
  });

  // M1 (storage-key impersonation): the imageUrl field is exempt from the
  // strict interceptor rule (staff-curated, multi-editor), so the service is
  // the backstop — a foreign key is allowed ONLY when it is already stored.
  describe('foreign image upload (M1)', () => {
    const OTHER_ID = '22222222-2222-2222-2222-222222222222';
    const FILE_SEGMENT = '33333333-3333-3333-3333-333333333333';
    const FOREIGN_KEY = `avatars/${OTHER_ID}/${FILE_SEGMENT}.jpg`;

    it('create() rejects a new foreign image key', async () => {
      changemakerRepo.exists.mockResolvedValue(false);

      await expect(
        service.create('admin-1', { ...baseCreateDto, imageUrl: FOREIGN_KEY }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(changemakerRepo.save).not.toHaveBeenCalled();
    });

    it('update() rejects a foreign image the profile does not already carry', async () => {
      changemakerRepo.findOne.mockResolvedValue(
        buildProfile({ imageUrl: null }),
      );

      await expect(
        service.update('admin-1', 'id-1', { imageUrl: FOREIGN_KEY }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(changemakerRepo.save).not.toHaveBeenCalled();
    });

    it('update() allows re-saving the foreign image already stored', async () => {
      changemakerRepo.findOne.mockResolvedValue(
        buildProfile({ imageUrl: FOREIGN_KEY }),
      );

      const result = await service.update('admin-1', 'id-1', {
        imageUrl: FOREIGN_KEY,
      });

      expect(result.imageUrl).toBe(FOREIGN_KEY);
    });
  });
});
