import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import { Community } from '../communities/entities/community.entity';
import { Event } from '../events/entities/event.entity';
import { Handle } from '../handles/entities/handle.entity';
import { HandlesService } from '../handles/handles.service';
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
import { SubprofileSocialLink } from './entities/subprofile-social-link.entity';
import { SubprofileAffiliation } from './entities/subprofile-affiliation.entity';
import { SubprofileMember } from './entities/subprofile-member.entity';
import { isSectionAllowed } from './subprofile-kinds';
import { toPublicDTO } from './subprofile-response';
import {
  MIN_BIO,
  MIN_CONTENT_ITEMS,
  validatePublish,
} from './subprofile-validation';
import { SubprofileEndorsementsService } from './subprofile-endorsements.service';
import { SubprofileFollowersService } from './subprofile-followers.service';
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
    coverUrl: null,
    accent: null,
    availability: null,
    ctaLabel: null,
    ctaUrl: null,
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
    isFeatured: false,
    collaborators: [],
    position: 0,
    createdAt: new Date(),
    ...overrides,
  };
}

const contentItems = (n: number): SubprofileItem[] =>
  Array.from({ length: n }, (_, i) => makeItem({ id: `it-${i}`, position: i }));

function makeSocialLink(
  overrides: Partial<SubprofileSocialLink> = {},
): SubprofileSocialLink {
  return {
    id: 'sl-1',
    subprofileId: 'sp-1',
    platform: 'instagram',
    urlOrHandle: '@nightform',
    position: 0,
    createdAt: new Date(),
    ...overrides,
  };
}

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

  it('exposes id + endorsement state for BOTH linked and unlinked personas', () => {
    const unlinked = makeSubprofile({
      linkVisibility: SubprofileLinkVisibility.Unlinked,
    });
    const unlinkedDto = toPublicDTO(unlinked, [], owner, [], 3, true);
    expect(unlinkedDto.id).toBe('sp-1');
    expect(unlinkedDto.endorsementCount).toBe(3);
    expect(unlinkedDto.viewerEndorsed).toBe(true);

    const linked = makeSubprofile({
      linkVisibility: SubprofileLinkVisibility.Linked,
    });
    const linkedDto = toPublicDTO(linked, [], owner, [], 5, false);
    expect(linkedDto.id).toBe('sp-1');
    expect(linkedDto.endorsementCount).toBe(5);
    expect(linkedDto.viewerEndorsed).toBe(false);
  });

  it('exposes follower state for BOTH linked and unlinked personas', () => {
    const unlinked = makeSubprofile({
      linkVisibility: SubprofileLinkVisibility.Unlinked,
    });
    const unlinkedDto = toPublicDTO(unlinked, [], owner, [], 3, true, 7, true);
    expect(unlinkedDto.id).toBe('sp-1');
    expect(unlinkedDto.followerCount).toBe(7);
    expect(unlinkedDto.viewerFollowing).toBe(true);

    const linked = makeSubprofile({
      linkVisibility: SubprofileLinkVisibility.Linked,
    });
    const linkedDto = toPublicDTO(linked, [], owner, [], 5, false, 2, false);
    expect(linkedDto.id).toBe('sp-1');
    expect(linkedDto.followerCount).toBe(2);
    expect(linkedDto.viewerFollowing).toBe(false);
  });

  it('defaults endorsementCount/viewerEndorsed/followerCount/viewerFollowing/affiliations when not supplied', () => {
    const sp = makeSubprofile();
    const dto = toPublicDTO(sp, [], owner);
    expect(dto.endorsementCount).toBe(0);
    expect(dto.viewerEndorsed).toBe(false);
    expect(dto.followerCount).toBe(0);
    expect(dto.viewerFollowing).toBe(false);
    expect(dto.affiliations).toEqual([]);
  });

  it('exposes affiliations for BOTH linked and unlinked personas (persona-to-entity, not owner)', () => {
    const resolvedAffiliations = [
      {
        targetType: 'event',
        targetSlug: 'summer-block-party',
        role: 'hosting',
        name: 'Summer Block Party',
        imageUrl: 'https://cdn/event.jpg',
      },
    ];

    const unlinked = makeSubprofile({
      linkVisibility: SubprofileLinkVisibility.Unlinked,
    });
    const unlinkedDto = toPublicDTO(
      unlinked,
      [],
      owner,
      [],
      0,
      false,
      0,
      false,
      resolvedAffiliations,
    );
    expect(unlinkedDto.affiliations).toEqual(resolvedAffiliations);

    const linked = makeSubprofile({
      linkVisibility: SubprofileLinkVisibility.Linked,
    });
    const linkedDto = toPublicDTO(
      linked,
      [],
      owner,
      [],
      0,
      false,
      0,
      false,
      resolvedAffiliations,
    );
    expect(linkedDto.affiliations).toEqual(resolvedAffiliations);
  });

  it('includes owner fields for a linked persona', () => {
    const sp = makeSubprofile({
      linkVisibility: SubprofileLinkVisibility.Linked,
    });
    const dto = toPublicDTO(sp, [], owner);
    expect(dto.ownerSlug).toBe('diogo');
    expect(dto.ownerName).toBe('Diogo Reis');
  });

  it('exposes persona-owned presence fields for an unlinked persona (never identifying)', () => {
    const sp = makeSubprofile({
      linkVisibility: SubprofileLinkVisibility.Unlinked,
      coverUrl: 'https://cdn/cover.jpg',
      accent: 'jade',
      availability: 'open_to_collabs',
      ctaLabel: 'Book me',
      ctaUrl: 'https://example.com/book',
    });
    const dto = toPublicDTO(sp, [], owner, [makeSocialLink()]);
    expect(dto.accent).toBe('jade');
    expect(dto.availability).toBe('open_to_collabs');
    expect(dto.ctaLabel).toBe('Book me');
    expect(dto.ctaUrl).toBe('https://example.com/book');
    expect(dto.socialLinks).toEqual([
      { platform: 'instagram', urlOrHandle: '@nightform' },
    ]);
    expect(dto.coverUrl).toBe('https://cdn/cover.jpg');
  });

  it('exposes the same persona-owned presence fields for a linked persona', () => {
    const sp = makeSubprofile({
      linkVisibility: SubprofileLinkVisibility.Linked,
      accent: 'ocean',
      availability: 'booking',
    });
    const dto = toPublicDTO(sp, [], owner, [makeSocialLink()]);
    expect(dto.accent).toBe('ocean');
    expect(dto.availability).toBe('booking');
    expect(dto.socialLinks).toEqual([
      { platform: 'instagram', urlOrHandle: '@nightform' },
    ]);
  });

  it('orders social links by position', () => {
    const sp = makeSubprofile();
    const dto = toPublicDTO(sp, [], owner, [
      makeSocialLink({ id: 'sl-2', platform: 'github', position: 1 }),
      makeSocialLink({ id: 'sl-1', platform: 'instagram', position: 0 }),
    ]);
    expect(dto.socialLinks.map((link) => link.platform)).toEqual([
      'instagram',
      'github',
    ]);
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
  let members: {
    findOne: jest.Mock;
    find: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    count: jest.Mock;
    delete: jest.Mock;
  };
  let profiles: { findOne: jest.Mock };
  let manager: {
    findOne: jest.Mock;
    count: jest.Mock;
    delete: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
  };
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
      // `create` in `create()`'s new transactional path (`manager.save(sp)`)
      // needs a concrete `id` on the entity it builds so the "creator is the
      // first member" test can pin an actual value rather than `undefined ===
      // undefined`.
      create: jest.fn().mockImplementation((value: Partial<Subprofile>) => ({
        id: 'sp-created-1',
        ...value,
      })),
      save: jest
        .fn()
        .mockImplementation((value: Subprofile) => Promise.resolve(value)),
      remove: jest.fn().mockResolvedValue(undefined),
      createQueryBuilder: jest.fn(),
    };
    items = { find: jest.fn().mockResolvedValue([]) };
    // Defaults to "is a member" so every pre-existing `getOwned`-backed test
    // (which never touched membership) keeps passing unchanged; tests that
    // care about the membership gate itself override this per-case.
    members = {
      findOne: jest.fn().mockResolvedValue({ id: 'member-1' }),
      find: jest.fn().mockResolvedValue([]),
      create: jest
        .fn()
        .mockImplementation((value: Partial<SubprofileMember>) => ({
          ...value,
        })),
      save: jest
        .fn()
        .mockImplementation((value: SubprofileMember) =>
          Promise.resolve(value),
        ),
      // `leave` counts remaining members; defaults to 2 so the "non-last
      // member leaves" path is the default and last-member tests override it.
      count: jest.fn().mockResolvedValue(2),
      delete: jest.fn().mockResolvedValue(undefined),
    };
    profiles = { findOne: jest.fn().mockResolvedValue(null) };
    manager = {
      // Backs `leave()`'s locked transaction: the persona-row lock (dispatched
      // on the `Subprofile` entity class, mirrors
      // `subprofile-invites.service.spec.ts`'s shared manager mock) and the
      // re-count of remaining members. Defaults to "non-last member" (2) so
      // every test that doesn't touch `leave` is unaffected; the `leave`
      // describe block below overrides per-case.
      findOne: jest.fn().mockImplementation((entity: unknown) => {
        if (entity === Subprofile) return Promise.resolve(makeSubprofile());
        return Promise.resolve(null);
      }),
      count: jest.fn().mockResolvedValue(2),
      delete: jest.fn().mockResolvedValue(undefined),
      create: jest
        .fn()
        .mockImplementation(
          (_entity: unknown, value: Partial<SubprofileItem>) => ({
            ...value,
          }),
        ),
      save: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    dataSource = {
      transaction: jest
        .fn()
        .mockImplementation(
          (
            runInTransaction: (
              entityManager: typeof manager,
            ) => Promise<unknown>,
          ) => runInTransaction(manager),
        ),
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
        {
          provide: getRepositoryToken(SubprofileSocialLink),
          useValue: { find: jest.fn().mockResolvedValue([]) },
        },
        {
          provide: getRepositoryToken(SubprofileAffiliation),
          useValue: { find: jest.fn().mockResolvedValue([]) },
        },
        { provide: getRepositoryToken(SubprofileMember), useValue: members },
        {
          provide: getRepositoryToken(Event),
          useValue: { find: jest.fn().mockResolvedValue([]) },
        },
        {
          provide: getRepositoryToken(Community),
          useValue: { find: jest.fn().mockResolvedValue([]) },
        },
        {
          provide: getRepositoryToken(Handle),
          useValue: { find: jest.fn().mockResolvedValue([]) },
        },
        { provide: DataSource, useValue: dataSource },
        { provide: BlockFilterService, useValue: blockFilter },
        {
          provide: HandlesService,
          useValue: {
            isTaken: jest.fn().mockResolvedValue(false),
            release: jest.fn().mockResolvedValue(undefined),
            rename: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: SubprofileEndorsementsService,
          useValue: {
            endorse: jest.fn(),
            withdrawEndorsement: jest.fn(),
            listEndorsers: jest.fn(),
            loadEndorsementCountsFor: jest
              .fn()
              .mockResolvedValue(new Map<string, number>()),
            viewerEndorsedFor: jest.fn().mockResolvedValue(new Set<string>()),
          },
        },
        {
          provide: SubprofileFollowersService,
          useValue: {
            follow: jest.fn(),
            unfollow: jest.fn(),
            loadFollowerCountsFor: jest
              .fn()
              .mockResolvedValue(new Map<string, number>()),
            viewerFollowingFor: jest.fn().mockResolvedValue(new Set<string>()),
          },
        },
      ],
    }).compile();
    service = module.get(SubprofilesService);
  });

  describe('create', () => {
    // `create` now writes the subprofile AND its first `subprofile_members`
    // row in ONE `dataSource.transaction` (see `getOwned` finding: an
    // untransacted create could orphan a subprofile with no membership row).
    // Both writes go through the mocked `manager.save`, in order — the
    // subprofile first, the membership row second — never through the plain
    // `subprofiles.save`/`members.save` repo mocks.
    it('slugifies the display name', async () => {
      subprofiles.find.mockResolvedValue([]); // no existing slugs
      await service.create('user-1', {
        kind: SubprofileKind.Musician,
        displayName: 'Night Form!!',
      });
      const saved = (manager.save.mock.calls[0] as [Subprofile])[0];
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
      const saved = (manager.save.mock.calls[0] as [Subprofile])[0];
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
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('inserts the creator as the first subprofile_members row, in the same transaction as the subprofile save', async () => {
      subprofiles.find.mockResolvedValue([]);
      await service.create('user-1', {
        kind: SubprofileKind.Musician,
        displayName: 'Nightform',
      });
      const savedSubprofile = (manager.save.mock.calls[0] as [Subprofile])[0];
      const savedMember = (manager.save.mock.calls[1] as [SubprofileMember])[0];
      // Pins a concrete id (from the `subprofiles.create` mock) rather than
      // asserting `undefined === undefined`.
      expect(savedSubprofile.id).toBe('sp-created-1');
      expect(savedMember).toMatchObject({
        subprofileId: 'sp-created-1',
        userId: 'user-1',
      });
    });

    it('translates a unique-violation into a 409 on duplicate slug/handle', async () => {
      subprofiles.find.mockResolvedValue([]);
      manager.save.mockRejectedValueOnce(
        Object.assign(new Error('duplicate key'), { code: '23505' }),
      );
      await expect(
        service.create('user-1', {
          kind: SubprofileKind.Musician,
          displayName: 'Nightform',
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('getOwned', () => {
    it('allows any member (not just the creator)', async () => {
      // creatorId owns sp1; memberId is a co-owner via subprofile_members.
      subprofiles.findOne.mockResolvedValue({ id: 'sp1', userId: 'creatorId' });
      members.findOne.mockResolvedValue({
        subprofileId: 'sp1',
        userId: 'memberId',
      });
      await expect(service.getOwned('memberId', 'sp1')).resolves.toMatchObject({
        id: 'sp1',
      });
    });

    it('rejects a non-member with 403', async () => {
      subprofiles.findOne.mockResolvedValue({ id: 'sp1', userId: 'creatorId' });
      members.findOne.mockResolvedValue(null);
      await expect(service.getOwned('strangerId', 'sp1')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('404s when the subprofile does not exist', async () => {
      subprofiles.findOne.mockResolvedValue(null);
      await expect(service.getOwned('anyone', 'missing-id')).rejects.toThrow(
        NotFoundException,
      );
      // Membership is never even checked for a subprofile that doesn't exist.
      expect(members.findOne).not.toHaveBeenCalled();
    });
  });

  describe('leave', () => {
    beforeEach(() => {
      subprofiles.findOne.mockResolvedValue(
        makeSubprofile({ id: 'sp-1', userId: 'creator-1' }),
      );
      // Membership gate passes by default (see the `members` mock default).
      members.findOne.mockResolvedValue({
        subprofileId: 'sp-1',
        userId: 'member-1',
      });
      // `leave` now re-counts INSIDE the locked transaction via the shared
      // `manager` mock (mirrors `invite`/`accept` in
      // `subprofile-invites.service.spec.ts`), not the plain `members.count`
      // repo — the top-level `manager` mock already defaults to this same
      // shape; each test below just overrides `manager.count` per-case.
    });

    it('throws ConflictException when the caller is the last remaining member (inside the locked transaction)', async () => {
      manager.count.mockResolvedValue(1);
      await expect(service.leave('member-1', 'sp-1')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(manager.findOne).toHaveBeenCalledWith(
        Subprofile,
        expect.objectContaining({
          where: { id: 'sp-1' },
          lock: { mode: 'pessimistic_write' },
        }),
      );
      expect(manager.delete).not.toHaveBeenCalled();
    });

    it('deletes the membership row when a non-last member leaves (inside the locked transaction)', async () => {
      manager.count.mockResolvedValue(2);
      await service.leave('member-1', 'sp-1');
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(manager.delete).toHaveBeenCalledWith(SubprofileMember, {
        subprofileId: 'sp-1',
        userId: 'member-1',
      });
    });

    it('propagates the 403 from getOwned when the caller is not a member', async () => {
      members.findOne.mockResolvedValue(null);
      await expect(service.leave('stranger-1', 'sp-1')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      // The membership gate 403s BEFORE the transaction is ever opened.
      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(manager.delete).not.toHaveBeenCalled();
    });
  });

  describe('listMine', () => {
    it('includes a persona the caller co-owns but did not create', async () => {
      // 'co-owner-1' is a member of a persona created by someone else.
      members.find.mockResolvedValue([
        { subprofileId: 'sp-created-by-other', userId: 'co-owner-1' },
      ]);
      subprofiles.find.mockResolvedValue([
        makeSubprofile({ id: 'sp-created-by-other', userId: 'creator-1' }),
      ]);
      const result = await service.listMine('co-owner-1');
      expect(members.find).toHaveBeenCalledWith({
        where: { userId: 'co-owner-1' },
        select: { subprofileId: true },
      });
      expect(subprofiles.find).toHaveBeenCalledWith({
        where: { id: In(['sp-created-by-other']) },
        order: { position: 'ASC', createdAt: 'ASC' },
      });
      expect(result.map((view) => view.id)).toContain('sp-created-by-other');
    });

    it('skips the subprofiles query entirely when the caller has no memberships', async () => {
      members.find.mockResolvedValue([]);
      const result = await service.listMine('lonely-user');
      expect(subprofiles.find).not.toHaveBeenCalled();
      expect(result).toEqual([]);
    });
  });

  describe('listForProfile', () => {
    it('lists a persona co-owned (not created) by the profile’s user', async () => {
      profiles.findOne.mockResolvedValue({
        slug: 'viewed-member',
        userId: 'viewed-user-id',
        firstName: 'Viewed',
        lastName: 'Member',
      });
      // 'viewed-user-id' co-owns a persona created by someone else.
      members.find.mockResolvedValue([
        { subprofileId: 'sp-co-owned', userId: 'viewed-user-id' },
      ]);
      subprofiles.find.mockResolvedValue([
        makeSubprofile({
          id: 'sp-co-owned',
          userId: 'creator-1',
          linkVisibility: SubprofileLinkVisibility.Linked,
          status: SubprofileStatus.Published,
        }),
      ]);
      const result = await service.listForProfile('viewed-member', 'viewer-id');
      expect(members.find).toHaveBeenCalledWith({
        where: { userId: 'viewed-user-id' },
        select: { subprofileId: true },
      });
      expect(subprofiles.find).toHaveBeenCalledWith({
        where: {
          id: In(['sp-co-owned']),
          linkVisibility: SubprofileLinkVisibility.Linked,
          status: SubprofileStatus.Published,
        },
        order: { position: 'ASC', createdAt: 'ASC' },
      });
      expect(result.map((view) => view.slug)).toContain('nightform');
    });

    it('skips the subprofiles query entirely when the profile’s user has no memberships', async () => {
      profiles.findOne.mockResolvedValue({
        slug: 'viewed-member',
        userId: 'viewed-user-id',
        firstName: 'Viewed',
        lastName: 'Member',
      });
      members.find.mockResolvedValue([]);
      const result = await service.listForProfile('viewed-member', 'viewer-id');
      expect(subprofiles.find).not.toHaveBeenCalled();
      expect(result).toEqual([]);
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
      const savedRows = (manager.save.mock.calls[0] as [SubprofileItem[]])[0];
      expect(savedRows.map((row) => row.position)).toEqual([0, 1]);
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
      const saved = (subprofiles.save.mock.calls[0] as [Subprofile])[0];
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
      const saved = (subprofiles.save.mock.calls[0] as [Subprofile])[0];
      expect(saved.status).toBe(SubprofileStatus.Draft);
    });
  });
});
