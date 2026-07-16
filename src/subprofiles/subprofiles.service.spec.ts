import {
  BadRequestException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { BlockFilterService } from '../social/block-filter.service';
import { Profile } from '../users/entities/profile.entity';
import {
  Subprofile,
  SubprofileKind,
  SubprofileLinkVisibility,
  SubprofileStatus,
  SubprofileVisibility,
} from './entities/subprofile.entity';
import {
  SubprofileItem,
  SubprofileSection,
} from './entities/subprofile-item.entity';
import { isSectionAllowed } from './subprofile-kinds';
import { toPublicDTO } from './subprofile-response';
import {
  MIN_BIO,
  MIN_CONTENT_ITEMS,
  validatePublish,
} from './subprofile-validation';
import { SubprofilesService } from './subprofiles.service';

// --- fixtures ---------------------------------------------------------------

function makeSubprofile(overrides: Partial<Subprofile> = {}): Subprofile {
  return {
    id: 'sp-1',
    userId: 'user-1',
    user: undefined as never,
    kind: SubprofileKind.Developer,
    slug: 'nightform',
    handle: null,
    displayName: 'Nightform',
    avatarUrl: null,
    tagline: null,
    bio: null,
    linkVisibility: SubprofileLinkVisibility.Unlinked,
    visibility: SubprofileVisibility.Open,
    status: SubprofileStatus.Draft,
    position: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeItem(overrides: Partial<SubprofileItem> = {}): SubprofileItem {
  return {
    id: 'it-1',
    subprofileId: 'sp-1',
    section: SubprofileSection.Projects,
    title: 'Thing',
    subtitle: null,
    description: null,
    url: null,
    imageUrl: null,
    date: null,
    meta: null,
    tags: [],
    position: 0,
    ...overrides,
  };
}

const contentItems = (n: number): SubprofileItem[] =>
  Array.from({ length: n }, (_, i) =>
    makeItem({ id: `it-${i}`, position: i }),
  );

// A subprofile that passes every unlinked publish requirement.
function completeUnlinked(overrides: Partial<Subprofile> = {}): Subprofile {
  return makeSubprofile({
    handle: 'nightform',
    avatarUrl: 'https://cdn/a.png',
    bio: 'x'.repeat(MIN_BIO),
    ...overrides,
  });
}

// --- validatePublish (pure) -------------------------------------------------

describe('validatePublish', () => {
  it('returns [] for a linked persona (only display name required)', () => {
    const sp = makeSubprofile({
      linkVisibility: SubprofileLinkVisibility.Linked,
      handle: null,
      avatarUrl: null,
      bio: null,
    });
    expect(validatePublish(sp, [])).toEqual([]);
  });

  it('returns [] when an unlinked persona meets every requirement', () => {
    const sp = completeUnlinked();
    expect(validatePublish(sp, contentItems(MIN_CONTENT_ITEMS))).toEqual([]);
  });

  it('flags handle_invalid for a missing/malformed handle', () => {
    const sp = completeUnlinked({ handle: 'A_B' });
    expect(validatePublish(sp, contentItems(3))).toContain('handle_invalid');
    const noHandle = completeUnlinked({ handle: null });
    expect(validatePublish(noHandle, contentItems(3))).toContain(
      'handle_invalid',
    );
  });

  it('flags handle_reserved for a reserved handle', () => {
    const sp = completeUnlinked({ handle: 'admin' });
    expect(validatePublish(sp, contentItems(3))).toContain('handle_reserved');
  });

  it('flags handle_taken when the handle is already claimed', () => {
    const sp = completeUnlinked({ handle: 'nightform' });
    expect(validatePublish(sp, contentItems(3), true)).toContain(
      'handle_taken',
    );
  });

  it('flags avatar_missing when there is no avatar', () => {
    const sp = completeUnlinked({ avatarUrl: null });
    expect(validatePublish(sp, contentItems(3))).toContain('avatar_missing');
  });

  it('flags bio_too_short when the bio is under the minimum', () => {
    const sp = completeUnlinked({ bio: 'too short' });
    expect(validatePublish(sp, contentItems(3))).toContain('bio_too_short');
  });

  it('flags not_enough_items when under the content threshold (links excluded)', () => {
    const sp = completeUnlinked();
    const items = [
      ...contentItems(2),
      makeItem({ id: 'link', section: SubprofileSection.Links }),
    ];
    // 2 content items + 1 link = still short.
    expect(validatePublish(sp, items)).toContain('not_enough_items');
  });

  it('flags blocked_terms when a blocked term appears in the bio', () => {
    const sp = completeUnlinked({
      bio: `${'x'.repeat(MIN_BIO)} slur-placeholder-1`,
    });
    expect(validatePublish(sp, contentItems(3))).toContain('blocked_terms');
  });
});

// --- isSectionAllowed guard -------------------------------------------------

describe('isSectionAllowed', () => {
  it('accepts a section that belongs to the kind and the universal links', () => {
    expect(isSectionAllowed('developer', 'projects')).toBe(true);
    expect(isSectionAllowed('developer', 'links')).toBe(true);
  });

  it('rejects a section from another kind', () => {
    expect(isSectionAllowed('developer', 'discography')).toBe(false);
  });
});

// --- toPublicDTO owner strip ------------------------------------------------

describe('toPublicDTO', () => {
  const owner = { slug: 'diogo', name: 'Diogo Reis' };

  it('omits owner fields for an unlinked persona', () => {
    const sp = makeSubprofile({
      linkVisibility: SubprofileLinkVisibility.Unlinked,
    });
    const dto = toPublicDTO(sp, [], owner);
    expect(dto.ownerSlug).toBeUndefined();
    expect(dto.ownerName).toBeUndefined();
  });

  it('includes owner fields for a linked persona', () => {
    const sp = makeSubprofile({
      linkVisibility: SubprofileLinkVisibility.Linked,
    });
    const dto = toPublicDTO(sp, [], owner);
    expect(dto.ownerSlug).toBe('diogo');
    expect(dto.ownerName).toBe('Diogo Reis');
  });
});

// --- service (mocked repositories) ------------------------------------------

describe('SubprofilesService', () => {
  let service: SubprofilesService;
  let subprofiles: {
    find: jest.Mock;
    findOne: jest.Mock;
    count: jest.Mock;
    exist: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    remove: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let items: { find: jest.Mock };
  let profiles: { findOne: jest.Mock };
  let manager: { delete: jest.Mock; create: jest.Mock; save: jest.Mock };
  let dataSource: { transaction: jest.Mock };
  let blockFilter: {
    isBlockedEitherWay: jest.Mock;
    excludeBlocked: jest.Mock;
  };

  beforeEach(async () => {
    subprofiles = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      exist: jest.fn().mockResolvedValue(false),
      create: jest.fn().mockImplementation((v) => ({ ...v })),
      save: jest.fn().mockImplementation((v) => Promise.resolve(v)),
      remove: jest.fn().mockResolvedValue(undefined),
      createQueryBuilder: jest.fn(),
    };
    items = { find: jest.fn().mockResolvedValue([]) };
    profiles = { findOne: jest.fn().mockResolvedValue(null) };
    manager = {
      delete: jest.fn().mockResolvedValue(undefined),
      create: jest.fn().mockImplementation((_e, v) => ({ ...v })),
      save: jest.fn().mockResolvedValue(undefined),
    };
    dataSource = {
      transaction: jest.fn().mockImplementation(async (cb) => cb(manager)),
    };
    blockFilter = {
      isBlockedEitherWay: jest.fn().mockResolvedValue(false),
      excludeBlocked: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SubprofilesService,
        { provide: getRepositoryToken(Subprofile), useValue: subprofiles },
        { provide: getRepositoryToken(SubprofileItem), useValue: items },
        { provide: getRepositoryToken(Profile), useValue: profiles },
        { provide: DataSource, useValue: dataSource },
        { provide: BlockFilterService, useValue: blockFilter },
      ],
    }).compile();
    service = module.get(SubprofilesService);
  });

  describe('create', () => {
    it('slugifies the display name', async () => {
      subprofiles.find.mockResolvedValue([]); // no existing slugs
      await service.create('user-1', {
        kind: SubprofileKind.Musician,
        displayName: 'Night Form!!',
      });
      const saved = subprofiles.save.mock.calls[0][0];
      expect(saved.slug).toBe('night-form');
    });

    it('appends a numeric suffix on a per-owner slug collision', async () => {
      subprofiles.find.mockResolvedValue([
        { slug: 'nightform' },
        { slug: 'nightform-2' },
      ]);
      await service.create('user-1', {
        kind: SubprofileKind.Musician,
        displayName: 'Nightform',
      });
      const saved = subprofiles.save.mock.calls[0][0];
      expect(saved.slug).toBe('nightform-3');
    });

    it('rejects creating beyond MAX_SUBPROFILES', async () => {
      subprofiles.count.mockResolvedValue(12);
      await expect(
        service.create('user-1', {
          kind: SubprofileKind.Generic,
          displayName: 'Overflow',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(subprofiles.save).not.toHaveBeenCalled();
    });
  });

  describe('replaceSection', () => {
    it('rejects a section that is not allowed for the kind', async () => {
      subprofiles.findOne.mockResolvedValue(
        makeSubprofile({ kind: SubprofileKind.Developer }),
      );
      await expect(
        service.replaceSection('user-1', 'sp-1', 'discography', [
          { title: 'x' },
        ]),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects an unknown section', async () => {
      subprofiles.findOne.mockResolvedValue(makeSubprofile());
      await expect(
        service.replaceSection('user-1', 'sp-1', 'not_a_section', [
          { title: 'x' },
        ]),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects more than MAX_ITEMS_PER_SECTION items', async () => {
      subprofiles.findOne.mockResolvedValue(
        makeSubprofile({ kind: SubprofileKind.Developer }),
      );
      const tooMany = Array.from({ length: 101 }, () => ({ title: 'x' }));
      await expect(
        service.replaceSection('user-1', 'sp-1', 'projects', tooMany),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('replaces items within a section (delete + insert with position)', async () => {
      subprofiles.findOne.mockResolvedValue(
        makeSubprofile({ kind: SubprofileKind.Developer }),
      );
      await service.replaceSection('user-1', 'sp-1', 'projects', [
        { title: 'A' },
        { title: 'B' },
      ]);
      expect(manager.delete).toHaveBeenCalledWith(SubprofileItem, {
        subprofileId: 'sp-1',
        section: SubprofileSection.Projects,
      });
      const savedRows = manager.save.mock.calls[0][0];
      expect(savedRows.map((r: SubprofileItem) => r.position)).toEqual([0, 1]);
    });
  });

  describe('publish', () => {
    it('publishes a complete unlinked persona and keeps its handle', async () => {
      const sp = completeUnlinked({ status: SubprofileStatus.Draft });
      subprofiles.findOne.mockResolvedValue(sp);
      items.find.mockResolvedValue(contentItems(MIN_CONTENT_ITEMS));
      subprofiles.exist.mockResolvedValue(false); // handle free

      const dto = await service.publish('user-1', 'sp-1');
      expect(dto.status).toBe(SubprofileStatus.Published);
      expect(dto.handle).toBe('nightform');
    });

    it('422s with unmet codes when the unlinked check fails', async () => {
      const sp = makeSubprofile({ handle: null, bio: null, avatarUrl: null });
      subprofiles.findOne.mockResolvedValue(sp);
      items.find.mockResolvedValue([]);
      await expect(service.publish('user-1', 'sp-1')).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
    });

    it('publishes a linked persona with no handle/avatar/bio and nulls the handle', async () => {
      const sp = makeSubprofile({
        linkVisibility: SubprofileLinkVisibility.Linked,
        handle: 'leftover',
        avatarUrl: null,
        bio: null,
        status: SubprofileStatus.Draft,
      });
      subprofiles.findOne.mockResolvedValue(sp);
      items.find.mockResolvedValue([]);
      const dto = await service.publish('user-1', 'sp-1');
      expect(dto.status).toBe(SubprofileStatus.Published);
      expect(dto.handle).toBeNull();
    });
  });

  describe('update', () => {
    it('nulls the handle when switching to linked', async () => {
      const sp = completeUnlinked({
        linkVisibility: SubprofileLinkVisibility.Unlinked,
      });
      subprofiles.findOne.mockResolvedValue(sp);
      await service.update('user-1', 'sp-1', {
        linkVisibility: SubprofileLinkVisibility.Linked,
      });
      const saved = subprofiles.save.mock.calls[0][0];
      expect(saved.handle).toBeNull();
    });

    it('drops back to draft when switching to unlinked', async () => {
      const sp = makeSubprofile({
        linkVisibility: SubprofileLinkVisibility.Linked,
        status: SubprofileStatus.Published,
      });
      subprofiles.findOne.mockResolvedValue(sp);
      await service.update('user-1', 'sp-1', {
        linkVisibility: SubprofileLinkVisibility.Unlinked,
      });
      const saved = subprofiles.save.mock.calls[0][0];
      expect(saved.status).toBe(SubprofileStatus.Draft);
    });
  });
});
