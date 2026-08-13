import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, In, IsNull } from 'typeorm';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { Community } from '../communities/entities/community.entity';
import { Event } from '../events/entities/event.entity';
import { Handle, HandleOwnerKind } from '../handles/entities/handle.entity';
import { HandlesService } from '../handles/handles.service';
import { NotificationsService } from '../notifications/notifications.service';
import { BlockFilterService } from '../social/block-filter.service';
import { Profile, ProfileVisibility } from '../users/entities/profile.entity';
import { UserStatus } from '../users/entities/user.entity';
import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import {
  Subprofile,
  SubprofileKind,
  SubprofileLinkVisibility,
  SubprofileStatus,
  SubprofileVisibility,
  type SkinData,
} from './entities/subprofile.entity';
import {
  SubprofileItem,
  SubprofileSection,
  type ItemStructured,
} from './entities/subprofile-item.entity';
import { SubprofileItemRevision } from './entities/subprofile-item-revision.entity';
import { SubprofileSocialLink } from './entities/subprofile-social-link.entity';
import { SubprofileAffiliation } from './entities/subprofile-affiliation.entity';
import { SubprofileMember } from './entities/subprofile-member.entity';
import { isSectionAllowed } from './subprofile-kinds';
import { toCardDTO, toPublicDTO, toSubprofileDTO } from './subprofile-response';
import {
  BLOCKED_TERMS,
  MIN_BIO,
  MIN_CONTENT_ITEMS,
  validatePublish,
} from './subprofile-validation';
import { SubprofileEndorsementsService } from './subprofile-endorsements.service';
import { SubprofileFollowersService } from './subprofile-followers.service';
import { SubprofileMembershipService } from './subprofile-membership.service';
import { SubprofileCreditsService } from './subprofile-credits.service';
import { SubprofilePublicReadService } from './subprofile-public-read.service';
import { editableSnapshot, SubprofilesService } from './subprofiles.service';

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
    skinData: null,
    removedAt: null,
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
    venue: null,
    doors: null,
    ticketUrl: null,
    gigState: null,
    medium: null,
    dimensions: null,
    edition: null,
    workState: null,
    structured: null,
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

// A minimal registered-username `handles` row, for `subprofile_credit`
// collaboration-credit tests (`resolveHandles` / `resolveMemberUserIdsByHandle`).
function makeHandleRow(overrides: Partial<Handle> = {}): Handle {
  return {
    name: 'alice',
    ownerKind: HandleOwnerKind.Profile,
    userId: 'user-2',
    user: undefined as never,
    subprofileId: null,
    subprofile: null,
    createdAt: new Date(),
    ...overrides,
  };
}

// A minimal member `profiles` row backing a `handles` row above.
function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    userId: 'user-2',
    user: undefined as never,
    slug: 'alice',
    firstName: 'Alice',
    lastName: 'A',
    pronouns: null,
    tagline: null,
    bio: null,
    location: null,
    avatarUrl: null,
    visibility: ProfileVisibility.Open,
    openTo: [],
    identities: [],
    discoverableIdentities: [],
    lookingFor: [],
    lookingForPublic: false,
    tags: [],
    vouchCount: 0,
    verified: false,
    verifiedAt: null,
    verifiedBy: null,
    privateNetwork: false,
    featuredConsent: false,
    now: null,
    joinedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
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

function makeViewer(overrides: Partial<CurrentUserData> = {}): CurrentUserData {
  return {
    userId: 'viewer-1',
    email: 'viewer@example.com',
    status: UserStatus.Active,
    role: 'member',
    ...overrides,
  };
}

// Awaits `promise`, asserts it rejected with a `ForbiddenException`, and
// asserts its serialised body (via the public `getResponse()` API — not an
// internal field) is EXACTLY `{ restrictedState }` — the Shared Contract's
// 403 body shape (design plan Phase 1b Task 1).
async function expectRestricted(
  promise: Promise<unknown>,
  restrictedState: 'private' | 'members_only' | 'removed',
): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(ForbiddenException);
  expect((caught as ForbiddenException).getResponse()).toEqual({
    restrictedState,
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
    // Reference the real centrally-managed blocklist by index rather than
    // spelling a slur into the test — the term appears as a standalone word so
    // the word-boundary matcher fires.
    const sp = completeUnlinked({
      bio: `${'x'.repeat(MIN_BIO)} ${BLOCKED_TERMS[0]}`,
    });
    expect(validatePublish(sp, contentItems(3))).toContain('blocked_terms');
  });

  it('does NOT flag blocked_terms on an innocuous substring match', () => {
    // Word-boundary matching must not trip on a slur embedded in a clean word
    // (the Scunthorpe problem the old substring `.includes()` had): "conspicuous"
    // embeds a blocked term as a substring but is not one as a whole word.
    const sp = completeUnlinked({
      bio: `${'x'.repeat(MIN_BIO)} a conspicuous and classic assistant`,
    });
    expect(validatePublish(sp, contentItems(3))).not.toContain('blocked_terms');
  });
});

// --- isSectionAllowed guard -------------------------------------------------

describe('isSectionAllowed', () => {
  it('accepts a section that belongs to the kind', () => {
    expect(isSectionAllowed('developer', 'projects')).toBe(true);
  });

  // `links` is a retired section — the enum value survives as a tombstone but
  // `sectionsForKind` no longer produces it, so it is no longer allowed.
  it('rejects the retired links section', () => {
    expect(isSectionAllowed('developer', 'links')).toBe(false);
  });

  it('rejects a section from another kind', () => {
    expect(isSectionAllowed('developer', 'discography')).toBe(false);
  });

  // The universal `gallery` section (appended by `sectionsForKind`) must be
  // allowed for every persona kind, not just some of them.
  it('accepts the universal gallery section for every kind', () => {
    for (const kind of Object.values(SubprofileKind)) {
      expect(isSectionAllowed(kind, SubprofileSection.Gallery)).toBe(true);
    }
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

// --- toCardDTO ---------------------------------------------------------------

// Personas redesign Phase 4 (design plan Task 1 Decision §3): the directory
// card mapper accepts a batched `followerCount` (default 0, mirrors
// `socialCount`/`tags`) rather than deriving it itself.
describe('toCardDTO', () => {
  it('defaults followerCount to 0 when not supplied', () => {
    const sp = makeSubprofile({ handle: 'nightform' });
    const card = toCardDTO(sp);
    expect(card.followerCount).toBe(0);
  });

  it('carries the batched followerCount through onto the card', () => {
    const sp = makeSubprofile({ handle: 'nightform' });
    const card = toCardDTO(sp, 3, ['ambient'], 12);
    expect(card.followerCount).toBe(12);
    expect(card.socialCount).toBe(3);
    expect(card.tags).toEqual(['ambient']);
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
  // Protect Your Work (revision history). `replaceSection` never touches this
  // repo directly (its writes go through the transaction `manager`, see the
  // constructor comment on `SubprofilesService`); this backs the plain reads
  // a future list/get endpoint (Task 8) will add.
  let itemRevisions: { find: jest.Mock; findOne: jest.Mock };
  let members: {
    findOne: jest.Mock;
    find: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    count: jest.Mock;
    delete: jest.Mock;
  };
  let profiles: { findOne: jest.Mock; find: jest.Mock };
  let handleRegistry: { find: jest.Mock };
  let notifications: { create: jest.Mock };
  let manager: {
    findOne: jest.Mock;
    find: jest.Mock;
    count: jest.Mock;
    delete: jest.Mock;
    remove: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
    query: jest.Mock;
  };
  let dataSource: { transaction: jest.Mock };
  let blockFilter: {
    isBlockedEitherWay: jest.Mock;
    excludeBlocked: jest.Mock;
    blockedUserIds: jest.Mock;
  };
  let contentModeration: { stateFor: jest.Mock; statesFor: jest.Mock };
  let followersService: {
    follow: jest.Mock;
    unfollow: jest.Mock;
    loadFollowerCountsFor: jest.Mock;
    viewerFollowingFor: jest.Mock;
  };
  // The four dependencies the service constructor gained when
  // SubprofileMembershipService / SubprofileCreditsService /
  // SubprofilePublicReadService were extracted from this service, plus
  // EventEmitter2. Each mock below reimplements just enough of the real
  // service's logic against the SAME subprofiles/members/manager/dataSource
  // mocks the rest of this file already drives, so every pre-existing test
  // that configures those shared mocks keeps exercising the same observable
  // behavior it did before the extraction.
  let membership: {
    isMember: jest.Mock;
    getOwned: jest.Mock;
    assertMember: jest.Mock;
    listMembers: jest.Mock;
    leave: jest.Mock;
    removeMember: jest.Mock;
    loadMemberCountsFor: jest.Mock;
  };
  // `credits` is a plain jest mock, not a reimplementation of
  // `SubprofileCreditsService`'s real diff/self-exclusion/dedup logic — that
  // logic is exercised for real in `subprofile-credits.service.spec.ts`.
  // `computeNewlyCreditedHandles` defaults to `[]` here so every pre-existing
  // test (none of which cares about the credit-notification branch) is
  // unaffected; the "subprofile_credit notification" describe block below
  // overrides it per-case to test THIS file's own responsibility: delegation.
  let credits: {
    computeNewlyCreditedHandles: jest.Mock;
    emitSubprofileCreditNotifications: jest.Mock;
  };
  let publicRead: {
    resolveHandles: jest.Mock;
    resolveCollaboratorsFor: jest.Mock;
    loadItemsFor: jest.Mock;
    loadSocialLinksFor: jest.Mock;
    resolveAffiliationsFor: jest.Mock;
    listForProfile: jest.Mock;
    getByHandle: jest.Mock;
    getBySlugForProfile: jest.Mock;
    directory: jest.Mock;
    searchByText: jest.Mock;
    listPublicHandles: jest.Mock;
  };
  let eventEmitter: { emit: jest.Mock };

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
    itemRevisions = {
      find: jest.fn().mockResolvedValue([]),
      // Protect Your Work (revision history), Task 8: backs `getRevision`'s
      // single-row lookup. Defaults to "not found" so every pre-existing
      // test (none of which touch this) is unaffected; the Task 8 describe
      // block below overrides per-case.
      findOne: jest.fn().mockResolvedValue(null),
    };
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
    profiles = {
      findOne: jest.fn().mockResolvedValue(null),
      // Only reached by `resolveHandles` when `handleRegistry.find` returns at
      // least one `ownerKind: 'profile'` row — every pre-existing test leaves
      // `handleRegistry` at its `[]` default, so this stays unexercised for
      // them; the `subprofile_credit` tests below override it.
      find: jest.fn().mockResolvedValue([]),
    };
    // Backs `resolveHandles`'s handle→profile/persona lookups AND
    // `resolveMemberUserIdsByHandle`'s narrower handle→userId lookup.
    // Defaults to "no handles registered" so every pre-existing test (none of
    // which exercise collaboration credits) is unaffected.
    handleRegistry = { find: jest.fn().mockResolvedValue([]) };
    // Backs `NotificationsService` — `replaceSection`'s `subprofile_credit`
    // emit (Personas discovery Phase 5, Moment 6).
    notifications = { create: jest.fn().mockResolvedValue(null) };
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
      // `replaceSection`'s revision pruning (`recordItemRevision`) re-reads
      // `subprofile_item_revisions` for the item it just wrote a snapshot
      // for. Defaults to "none yet" so every pre-existing test (none of
      // which touch revisions) is unaffected; the revision-history tests
      // below override this per-case.
      find: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(2),
      delete: jest.fn().mockResolvedValue(undefined),
      remove: jest.fn().mockResolvedValue(undefined),
      create: jest
        .fn()
        .mockImplementation(
          (_entity: unknown, value: Partial<SubprofileItem>) => ({
            ...value,
          }),
        ),
      save: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      // Backs `create()`'s per-user advisory lock
      // (`pg_advisory_xact_lock`) taken at the top of its transaction.
      query: jest.fn().mockResolvedValue(undefined),
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
      // Only reached by `resolveHandles` when `handleRegistry.find` returns at
      // least one row — see the `profiles.find` comment above.
      blockedUserIds: jest.fn().mockResolvedValue(new Set<string>()),
    };
    // Defaults to "fully visible" (no takedown row) so every pre-existing
    // test is unaffected; the `getByHandle`/`getBySlugForProfile` describe
    // blocks below override per-case.
    contentModeration = {
      stateFor: jest.fn().mockResolvedValue({ hidden: false, removed: false }),
      // Batched takedown lookup used by `dropModeratedSubprofiles`. Empty map =
      // nothing moderated, so every persona passes the filter (individual tests
      // override to hide/remove a specific slug).
      statesFor: jest.fn().mockResolvedValue(new Map()),
    };
    followersService = {
      follow: jest.fn(),
      unfollow: jest.fn(),
      loadFollowerCountsFor: jest
        .fn()
        .mockResolvedValue(new Map<string, number>()),
      viewerFollowingFor: jest.fn().mockResolvedValue(new Set<string>()),
    };

    membership = {
      isMember: jest.fn().mockImplementation(
        async (userId: string, subprofileId: string) => {
          const row = await members.findOne({
            where: { subprofileId, userId },
            select: { id: true },
          });
          return row !== null;
        },
      ),
      getOwned: jest.fn(),
      assertMember: jest.fn(),
      listMembers: jest.fn().mockResolvedValue([]),
      leave: jest.fn(),
      removeMember: jest.fn().mockResolvedValue(undefined),
      // Mirrors SubprofileMembershipService.loadMemberCountsFor's contract
      // (a grouped tally keyed by subprofileId) via members.find rather than
      // its real createQueryBuilder call, since the shared `members` mock
      // only implements the repository-style methods this file already uses.
      loadMemberCountsFor: jest.fn().mockImplementation(
        async (subprofileIds: string[]) => {
          const counts = new Map<string, number>();
          if (!subprofileIds.length) return counts;
          const rows: { subprofileId: string }[] = await members.find({
            where: { subprofileId: In(subprofileIds) },
          });
          for (const row of rows) {
            counts.set(
              row.subprofileId,
              (counts.get(row.subprofileId) ?? 0) + 1,
            );
          }
          return counts;
        },
      ),
    };
    // getOwned/assertMember/leave reference `membership` by closure, so they
    // are wired up after the object literal exists rather than inline in it.
    membership.getOwned.mockImplementation(
      async (userId: string, id: string) => {
        const sp = await subprofiles.findOne({ where: { id } });
        if (!sp) {
          throw new NotFoundException('Subprofile not found');
        }
        if (!(await membership.isMember(userId, id))) {
          throw new ForbiddenException('Not your subprofile');
        }
        return sp;
      },
    );
    membership.assertMember.mockImplementation(
      (userId: string, id: string) => membership.getOwned(userId, id),
    );
    membership.leave.mockImplementation(async (userId: string, id: string) => {
      await membership.getOwned(userId, id);
      await dataSource.transaction(async (m: typeof manager) => {
        await m.findOne(Subprofile, {
          where: { id },
          lock: { mode: 'pessimistic_write' },
        });
        const count = await m.count(SubprofileMember, {
          where: { subprofileId: id },
        });
        if (count <= 1) {
          throw new ConflictException(
            'You are the only owner. Delete the persona instead of leaving.',
          );
        }
        await m.delete(SubprofileMember, { subprofileId: id, userId });
      });
    });

    // computeNewlyCreditedHandles defaults to empty, so replaceSection's
    // best-effort notification branch stays closed for every test except the
    // "subprofile_credit notification" describe block below, which overrides
    // it per-case (`mockResolvedValueOnce`) to exercise the delegation.
    credits = {
      computeNewlyCreditedHandles: jest.fn().mockResolvedValue([]),
      emitSubprofileCreditNotifications: jest.fn().mockResolvedValue(undefined),
    };

    // Shared Contract gate (removed -> private -> members_only -> ok),
    // reused by both getByHandle and getBySlugForProfile below. Mirrors
    // SubprofilePublicReadService.buildPublicView against this file's own
    // membership/contentModeration/blockFilter mocks.
    const buildPublicView = async (
      sp: Subprofile,
      viewer: CurrentUserData | undefined,
      ownerRef: { slug: string; name: string } | undefined,
    ) => {
      const isOwner = viewer
        ? await membership.isMember(viewer.userId, sp.id)
        : false;
      if (!isOwner) {
        if (sp.removedAt) {
          throw new ForbiddenException({ restrictedState: 'removed' });
        }
        if (sp.status !== SubprofileStatus.Published) {
          throw new NotFoundException('Subprofile not found');
        }
        if (sp.visibility === SubprofileVisibility.Private) {
          throw new ForbiddenException({ restrictedState: 'private' });
        }
        if (
          sp.visibility === SubprofileVisibility.Network &&
          viewer?.status !== UserStatus.Active
        ) {
          throw new ForbiddenException({ restrictedState: 'members_only' });
        }
        const moderation = await contentModeration.stateFor(
          'subprofile',
          sp.slug,
        );
        if (moderation.hidden || moderation.removed) {
          throw new NotFoundException('Subprofile not found');
        }
        if (
          viewer &&
          (await blockFilter.isBlockedEitherWay(viewer.userId, sp.userId))
        ) {
          throw new NotFoundException('Subprofile not found');
        }
      }
      return toPublicDTO(
        sp,
        [],
        ownerRef,
        [],
        0,
        false,
        0,
        false,
        [],
        new Map(),
        isOwner,
      );
    };

    publicRead = {
      // Backs replaceSection's collaborator validation. Mirrors
      // SubprofilePublicReadService.resolveHandles for the member-owned-handle
      // path only (the persona-handle path isn't exercised by any test here).
      resolveHandles: jest.fn().mockImplementation(
        async (handleNames: string[], viewerId: string) => {
          const collaboratorByHandle = new Map<
            string,
            { handle: string; type: string; name: string; avatarUrl: string | null; slug: string | null }
          >();
          const uniqueHandles = [...new Set(handleNames)];
          if (!uniqueHandles.length) return collaboratorByHandle;
          const handleRows: Handle[] = await handleRegistry.find({
            where: { name: In(uniqueHandles) },
          });
          if (!handleRows.length) return collaboratorByHandle;
          const profileUserIds = [
            ...new Set(
              handleRows
                .filter(
                  (row) =>
                    row.ownerKind === HandleOwnerKind.Profile && row.userId,
                )
                .map((row) => row.userId as string),
            ),
          ];
          const profileRows: Profile[] = profileUserIds.length
            ? await profiles.find({ where: { userId: In(profileUserIds) } })
            : [];
          const profileByUserId = new Map(
            profileRows.map((profile) => [profile.userId, profile]),
          );
          const blockedOwnerIds: Set<string> = await blockFilter.blockedUserIds(
            viewerId,
            profileRows.map((profile) => profile.userId),
          );
          for (const row of handleRows) {
            if (row.ownerKind === HandleOwnerKind.Profile && row.userId) {
              const profile = profileByUserId.get(row.userId);
              if (!profile || blockedOwnerIds.has(profile.userId)) {
                continue;
              }
              collaboratorByHandle.set(row.name, {
                handle: row.name,
                type: 'member',
                name: `${profile.firstName} ${profile.lastName}`.trim(),
                avatarUrl: profile.avatarUrl,
                slug: profile.slug,
              });
            }
          }
          return collaboratorByHandle;
        },
      ),
      resolveCollaboratorsFor: jest.fn().mockResolvedValue(new Map()),
      loadItemsFor: jest.fn().mockResolvedValue(new Map()),
      loadSocialLinksFor: jest.fn().mockResolvedValue(new Map()),
      resolveAffiliationsFor: jest.fn().mockResolvedValue(new Map()),
      listForProfile: jest.fn().mockImplementation(
        async (ownerSlug: string, viewerId: string) => {
          const profile = await profiles.findOne({
            where: { slug: ownerSlug },
          });
          if (!profile) {
            throw new NotFoundException('Profile not found');
          }
          if (
            await blockFilter.isBlockedEitherWay(viewerId, profile.userId)
          ) {
            return [];
          }
          const memberRows: { subprofileId: string }[] = await members.find({
            where: { userId: profile.userId },
            select: { subprofileId: true },
          });
          const memberIds = memberRows.map((row) => row.subprofileId);
          const linkedSps: Subprofile[] = memberIds.length
            ? await subprofiles.find({
                where: {
                  id: In(memberIds),
                  linkVisibility: SubprofileLinkVisibility.Linked,
                  status: SubprofileStatus.Published,
                  removedAt: IsNull(),
                },
                order: { position: 'ASC', createdAt: 'ASC' },
              })
            : [];
          const owner = {
            slug: profile.slug,
            name: `${profile.firstName} ${profile.lastName}`.trim(),
          };
          return linkedSps.map((sp) => toPublicDTO(sp, [], owner));
        },
      ),
      getByHandle: jest.fn().mockImplementation(
        async (handle: string, viewer: CurrentUserData | undefined) => {
          const sp = await subprofiles.findOne({
            where: {
              handle,
              linkVisibility: SubprofileLinkVisibility.Unlinked,
            },
          });
          if (!sp) {
            throw new NotFoundException('Subprofile not found');
          }
          return buildPublicView(sp, viewer, undefined);
        },
      ),
      getBySlugForProfile: jest.fn().mockImplementation(
        async (
          ownerSlug: string,
          subslug: string,
          viewer: CurrentUserData | undefined,
        ) => {
          const profile = await profiles.findOne({
            where: { slug: ownerSlug },
          });
          if (!profile) {
            throw new NotFoundException('Profile not found');
          }
          const sp = await subprofiles.findOne({
            where: {
              slug: subslug,
              userId: profile.userId,
              linkVisibility: SubprofileLinkVisibility.Linked,
            },
          });
          if (!sp) {
            throw new NotFoundException('Subprofile not found');
          }
          const owner = {
            slug: profile.slug,
            name: `${profile.firstName} ${profile.lastName}`.trim(),
          };
          return buildPublicView(sp, viewer, owner);
        },
      ),
      // `SubprofilesService.directory` is a pure one-line delegation to
      // `this.publicRead.directory(query, viewerId)` (subprofiles.service.ts)
      // — it owns no pagination/filter/batch logic of its own. A faithful
      // mock of the real `SubprofilePublicReadService.directory()` (offset
      // paging, moderated-takedown exclusion, LIKE-escaped text search, the
      // follower/social/tags/ownerSlug batches) belongs in, and now lives in,
      // `subprofile-public-read.service.spec.ts` against the REAL service.
      // Reimplementing that logic here would only test the reimplementation,
      // not production, so this stays a plain default; the `directory`
      // describe block below overrides it per-case with a static fixture and
      // asserts delegation only.
      directory: jest
        .fn()
        .mockResolvedValue({ items: [], total: 0, page: 1, limit: 20 }),
      searchByText: jest.fn().mockResolvedValue([]),
      listPublicHandles: jest.fn().mockResolvedValue({ items: [] }),
    };

    eventEmitter = { emit: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SubprofilesService,
        { provide: getRepositoryToken(Subprofile), useValue: subprofiles },
        { provide: getRepositoryToken(SubprofileItem), useValue: items },
        {
          provide: getRepositoryToken(SubprofileItemRevision),
          useValue: itemRevisions,
        },
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
        { provide: getRepositoryToken(Handle), useValue: handleRegistry },
        { provide: DataSource, useValue: dataSource },
        { provide: BlockFilterService, useValue: blockFilter },
        { provide: ContentModerationService, useValue: contentModeration },
        { provide: NotificationsService, useValue: notifications },
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
          useValue: followersService,
        },
        { provide: SubprofileMembershipService, useValue: membership },
        { provide: SubprofileCreditsService, useValue: credits },
        { provide: SubprofilePublicReadService, useValue: publicRead },
        { provide: EventEmitter2, useValue: eventEmitter },
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
      // The cap check now runs INSIDE the transaction (under the per-user
      // advisory lock) and counts via `manager.count`, not the plain
      // `subprofiles.count` repo mock — a full persona count trips it.
      manager.count.mockResolvedValueOnce(12);
      await expect(
        service.create('user-1', {
          kind: SubprofileKind.Generic,
          displayName: 'Overflow',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      // The advisory lock is taken before the count, and the cap breach is
      // surfaced as a BadRequestException (never mistranslated to a 409).
      expect(manager.query).toHaveBeenCalled();
      expect(manager.save).not.toHaveBeenCalled();
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

    // Personas redesign Phase 2 dashboard plan Task 4 / Decision §5:
    // `memberCount` on the owner list DTO, populated via ONE grouped count
    // over `subprofile_members` — never a per-persona query. `members.find`
    // is called twice total in `listMine`: once for the caller's own
    // memberships (`where: { userId }`), once for the grouped co-owner count
    // (`where: { subprofileId: In(ids) }`) — the mock below branches on that
    // shape to serve each call its own rows.
    it('reports memberCount 1 for a solo persona (creator-only)', async () => {
      members.find.mockImplementation(
        (options: { where: { userId?: string } }) => {
          if (options.where.userId) {
            return Promise.resolve([
              { subprofileId: 'sp-solo', userId: 'user-1' },
            ]);
          }
          return Promise.resolve([{ subprofileId: 'sp-solo' }]);
        },
      );
      subprofiles.find.mockResolvedValue([
        makeSubprofile({ id: 'sp-solo', userId: 'user-1' }),
      ]);
      const result = await service.listMine('user-1');
      expect(result.find((view) => view.id === 'sp-solo')?.memberCount).toBe(1);
    });

    it('reports the true co-owner headcount for a co-owned persona, via ONE grouped query', async () => {
      members.find.mockImplementation(
        (options: { where: { userId?: string } }) => {
          if (options.where.userId) {
            return Promise.resolve([
              { subprofileId: 'sp-co-owned', userId: 'user-1' },
            ]);
          }
          return Promise.resolve([
            { subprofileId: 'sp-co-owned', userId: 'user-1' },
            { subprofileId: 'sp-co-owned', userId: 'co-owner-2' },
            { subprofileId: 'sp-co-owned', userId: 'co-owner-3' },
          ]);
        },
      );
      subprofiles.find.mockResolvedValue([
        makeSubprofile({ id: 'sp-co-owned', userId: 'user-1' }),
      ]);
      const result = await service.listMine('user-1');
      expect(
        result.find((view) => view.id === 'sp-co-owned')?.memberCount,
      ).toBe(3);
      // Exactly two `members.find` calls total for the whole list — NOT one
      // grouped-count call per persona (no N+1).
      expect(members.find).toHaveBeenCalledTimes(2);
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
          removedAt: IsNull(),
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

  // `SubprofilesService.directory` (subprofiles.service.ts:1354-1364) owns NO
  // pagination/filter/batch logic of its own — it is a pure one-line
  // delegation: `return this.publicRead.directory(query, viewerId)`. So this
  // layer's only real behavior is passing its arguments through and handing
  // back whatever `publicRead.directory` resolves to, unchanged. The actual
  // offset-paging, moderated-takedown exclusion, LIKE-escaped text search,
  // and follower/social/tags/ownerSlug batching are `SubprofilePublicReadService
  // .directory()`'s own logic, exercised against the REAL implementation in
  // `subprofile-public-read.service.spec.ts`.
  describe('directory', () => {
    it('delegates straight through to publicRead.directory with the same arguments and return value', async () => {
      const fixtureResult = {
        items: [
          {
            handle: 'nightform',
            kind: SubprofileKind.Developer,
            displayName: 'Nightform',
            avatarUrl: null,
            tagline: null,
            accent: null,
            availability: null,
            socialCount: 0,
            tags: [],
            followerCount: 12,
            linkVisibility: SubprofileLinkVisibility.Unlinked,
            slug: 'nightform',
            ownerSlug: null,
          },
        ],
        total: 1,
        page: 1,
        limit: 40,
      };
      publicRead.directory.mockResolvedValue(fixtureResult);
      const query = { kind: SubprofileKind.Developer, page: 2 };

      const result = await service.directory(query, 'viewer-1');

      expect(publicRead.directory).toHaveBeenCalledTimes(1);
      expect(publicRead.directory).toHaveBeenCalledWith(query, 'viewer-1');
      // The exact same object publicRead.directory resolved to, not a
      // reshaped/recomputed one — this layer does no transformation.
      expect(result).toBe(fixtureResult);
    });
  });

  // Personas redesign Phase 1b Task 1 (Shared Contract rule order): owner sees
  // any status/visibility; else removedAt -> 403 removed; not published -> 404;
  // private -> 403 private; network + not an authenticated active member ->
  // 403 members_only; else 200.
  describe('getByHandle', () => {
    it('404s when no subprofile matches the handle', async () => {
      subprofiles.findOne.mockResolvedValue(null);
      await expect(
        service.getByHandle('missing', makeViewer()),
      ).rejects.toThrow(NotFoundException);
    });

    it('queries by handle + unlinked only — status/visibility are no longer pre-filtered', async () => {
      subprofiles.findOne.mockResolvedValue(null);
      await service
        .getByHandle('nightform', makeViewer())
        .catch(() => undefined);
      expect(subprofiles.findOne).toHaveBeenCalledWith({
        where: {
          handle: 'nightform',
          linkVisibility: SubprofileLinkVisibility.Unlinked,
        },
      });
    });

    it('returns the full DTO (status: draft) to the owner viewing their own unpublished draft', async () => {
      const sp = makeSubprofile({
        handle: 'nightform',
        status: SubprofileStatus.Draft,
        visibility: SubprofileVisibility.Private,
      });
      subprofiles.findOne.mockResolvedValue(sp);
      members.findOne.mockResolvedValue({ id: 'member-1' }); // owner/co-owner
      const dto = await service.getByHandle('nightform', makeViewer());
      expect(dto.status).toBe(SubprofileStatus.Draft);
    });

    it('404s a non-owner viewing an unpublished draft (not a distinct restricted state)', async () => {
      const sp = makeSubprofile({
        handle: 'nightform',
        status: SubprofileStatus.Draft,
      });
      subprofiles.findOne.mockResolvedValue(sp);
      members.findOne.mockResolvedValue(null); // not a member
      await expect(
        service.getByHandle('nightform', makeViewer()),
      ).rejects.toThrow(NotFoundException);
    });

    it('403s "removed" for a removed persona, ahead of the status check', async () => {
      const sp = makeSubprofile({
        handle: 'nightform',
        status: SubprofileStatus.Draft,
        removedAt: new Date(),
      });
      subprofiles.findOne.mockResolvedValue(sp);
      members.findOne.mockResolvedValue(null);
      await expectRestricted(
        service.getByHandle('nightform', makeViewer()),
        'removed',
      );
    });

    it('403s "removed" even for an owner-eligible handle once removed (non-owner viewer)', async () => {
      const sp = makeSubprofile({
        handle: 'nightform',
        status: SubprofileStatus.Published,
        visibility: SubprofileVisibility.Open,
        removedAt: new Date(),
      });
      subprofiles.findOne.mockResolvedValue(sp);
      members.findOne.mockResolvedValue(null);
      await expectRestricted(
        service.getByHandle('nightform', undefined),
        'removed',
      );
    });

    it('403s "private" for a visitor on a published private persona', async () => {
      const sp = makeSubprofile({
        handle: 'nightform',
        status: SubprofileStatus.Published,
        visibility: SubprofileVisibility.Private,
      });
      subprofiles.findOne.mockResolvedValue(sp);
      members.findOne.mockResolvedValue(null);
      await expectRestricted(
        service.getByHandle('nightform', makeViewer()),
        'private',
      );
    });

    it('403s "private" for an anonymous (signed-out) visitor on a published private persona', async () => {
      const sp = makeSubprofile({
        handle: 'nightform',
        status: SubprofileStatus.Published,
        visibility: SubprofileVisibility.Private,
      });
      subprofiles.findOne.mockResolvedValue(sp);
      members.findOne.mockResolvedValue(null);
      await expectRestricted(
        service.getByHandle('nightform', undefined),
        'private',
      );
    });

    it('403s "members_only" for an anonymous (signed-out) visitor on a network persona', async () => {
      const sp = makeSubprofile({
        handle: 'nightform',
        status: SubprofileStatus.Published,
        visibility: SubprofileVisibility.Network,
      });
      subprofiles.findOne.mockResolvedValue(sp);
      members.findOne.mockResolvedValue(null);
      await expectRestricted(
        service.getByHandle('nightform', undefined),
        'members_only',
      );
    });

    it('returns 200 to an authenticated active member on a network persona', async () => {
      const sp = makeSubprofile({
        handle: 'nightform',
        status: SubprofileStatus.Published,
        visibility: SubprofileVisibility.Network,
      });
      subprofiles.findOne.mockResolvedValue(sp);
      members.findOne.mockResolvedValue(null); // not owner, but active member
      const dto = await service.getByHandle('nightform', makeViewer());
      expect(dto.status).toBe(SubprofileStatus.Published);
    });

    it('403s "members_only" for a logged-in but non-active (suspended) viewer on a network persona', async () => {
      // A suspended viewer is treated the same as anonymous for `network` —
      // members_only, never a silent 200.
      const sp = makeSubprofile({
        handle: 'nightform',
        status: SubprofileStatus.Published,
        visibility: SubprofileVisibility.Network,
      });
      subprofiles.findOne.mockResolvedValue(sp);
      members.findOne.mockResolvedValue(null);
      await expectRestricted(
        service.getByHandle(
          'nightform',
          makeViewer({ status: UserStatus.Suspended }),
        ),
        'members_only',
      );
    });
  });

  describe('getBySlugForProfile', () => {
    it('404s when no profile matches the owner slug', async () => {
      profiles.findOne.mockResolvedValue(null);
      await expect(
        service.getBySlugForProfile('missing', 'sub', makeViewer()),
      ).rejects.toThrow(NotFoundException);
    });

    it('404s when the owner has no such linked persona', async () => {
      profiles.findOne.mockResolvedValue({
        slug: 'diogo',
        userId: 'owner-1',
        firstName: 'Diogo',
        lastName: 'Reis',
      });
      subprofiles.findOne.mockResolvedValue(null);
      await expect(
        service.getBySlugForProfile('diogo', 'missing-sub', makeViewer()),
      ).rejects.toThrow(NotFoundException);
    });

    it('returns the full DTO (status: draft) + owner fields to the owner viewing their own draft', async () => {
      profiles.findOne.mockResolvedValue({
        slug: 'diogo',
        userId: 'owner-1',
        firstName: 'Diogo',
        lastName: 'Reis',
      });
      const sp = makeSubprofile({
        userId: 'owner-1',
        slug: 'nightform',
        linkVisibility: SubprofileLinkVisibility.Linked,
        status: SubprofileStatus.Draft,
      });
      subprofiles.findOne.mockResolvedValue(sp);
      members.findOne.mockResolvedValue({ id: 'member-1' });
      const dto = await service.getBySlugForProfile(
        'diogo',
        'nightform',
        makeViewer(),
      );
      expect(dto.status).toBe(SubprofileStatus.Draft);
      expect(dto.ownerSlug).toBe('diogo');
      expect(dto.ownerName).toBe('Diogo Reis');
    });

    it('403s "private" for a visitor on a published private linked persona', async () => {
      profiles.findOne.mockResolvedValue({
        slug: 'diogo',
        userId: 'owner-1',
        firstName: 'Diogo',
        lastName: 'Reis',
      });
      const sp = makeSubprofile({
        userId: 'owner-1',
        slug: 'nightform',
        linkVisibility: SubprofileLinkVisibility.Linked,
        status: SubprofileStatus.Published,
        visibility: SubprofileVisibility.Private,
      });
      subprofiles.findOne.mockResolvedValue(sp);
      members.findOne.mockResolvedValue(null);
      await expectRestricted(
        service.getBySlugForProfile('diogo', 'nightform', makeViewer()),
        'private',
      );
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

    // The universal `gallery` section is a photo strip, capped far tighter
    // than the generic MAX_ITEMS_PER_SECTION limit above (design plan: "up
    // to 6 photos").
    it('rejects a 7th gallery photo', async () => {
      subprofiles.findOne.mockResolvedValue(
        makeSubprofile({ kind: SubprofileKind.Developer }),
      );
      const sevenPhotos = Array.from({ length: 7 }, (_, index) => ({
        title: `Photo ${index}`,
      }));
      await expect(
        service.replaceSection('user-1', 'sp-1', 'gallery', sevenPhotos),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('accepts exactly 6 gallery photos', async () => {
      subprofiles.findOne.mockResolvedValue(
        makeSubprofile({ kind: SubprofileKind.Developer }),
      );
      const sixPhotos = Array.from({ length: 6 }, (_, index) => ({
        title: `Photo ${index}`,
      }));
      await expect(
        service.replaceSection('user-1', 'sp-1', 'gallery', sixPhotos),
      ).resolves.toBeDefined();
    });

    // Protect Your Work (revision history), Task 7: `replaceSection` no
    // longer unconditionally deletes every row in the section and recreates
    // it (`subprofile_item_revisions.item_id` is `ON DELETE CASCADE`, so
    // that shape would cascade away a revision the instant its item's row
    // was replaced (see the long comment in `replaceSection` itself).
    // Brand-new items (no existing row at that position) are still plain
    // inserts; only rows that fall off the end of a shrinking section are
    // actually deleted now (`manager.remove`, not `manager.delete`).
    it('inserts brand-new items with position, without deleting the section first', async () => {
      subprofiles.findOne.mockResolvedValue(
        makeSubprofile({ kind: SubprofileKind.Developer }),
      );
      manager.find.mockResolvedValue([]); // no existing rows in this section
      await service.replaceSection('user-1', 'sp-1', 'projects', [
        { title: 'A' },
        { title: 'B' },
      ]);
      expect(manager.delete).not.toHaveBeenCalledWith(
        SubprofileItem,
        expect.anything(),
      );
      expect(manager.remove).not.toHaveBeenCalled();
      const savedRows = (manager.save.mock.calls[0] as [SubprofileItem[]])[0];
      expect(savedRows.map((row) => row.position)).toEqual([0, 1]);
    });

    it('deletes rows that fall off the end when a section shrinks', async () => {
      subprofiles.findOne.mockResolvedValue(
        makeSubprofile({ kind: SubprofileKind.Developer }),
      );
      const keep = makeItem({
        id: 'it-keep',
        section: SubprofileSection.Projects,
        title: 'Keep me',
        position: 0,
      });
      const drop = makeItem({
        id: 'it-drop',
        section: SubprofileSection.Projects,
        title: 'Drop me',
        position: 1,
      });
      manager.find.mockImplementation((entity: unknown) =>
        entity === SubprofileItem
          ? Promise.resolve([keep, drop])
          : Promise.resolve([]),
      );
      await service.replaceSection('user-1', 'sp-1', 'projects', [
        { title: 'Keep me' }, // unchanged content at position 0
      ]);
      expect(manager.remove).toHaveBeenCalledWith([drop]);
    });

    // Personas redesign Phase 0 round-trip (design plan Task 7 Step 4): the
    // new flat scalars survive the section-replace write path.
    it('persists the Phase 0 skin scalars on a gig item (venue/doors/ticketUrl/gigState)', async () => {
      subprofiles.findOne.mockResolvedValue(
        makeSubprofile({ kind: SubprofileKind.Musician }),
      );
      await service.replaceSection('user-1', 'sp-1', 'gigs', [
        {
          title: 'Live at The Grotto',
          venue: 'The Grotto',
          doors: '8pm',
          ticketUrl: 'https://tickets.example/grotto',
          gigState: 'sold_out',
        },
      ]);
      const savedRows = (manager.save.mock.calls[0] as [SubprofileItem[]])[0];
      expect(savedRows[0]!.venue).toBe('The Grotto');
      expect(savedRows[0]!.doors).toBe('8pm');
      expect(savedRows[0]!.ticketUrl).toBe('https://tickets.example/grotto');
      expect(savedRows[0]!.gigState).toBe('sold_out');
    });

    // Personas redesign Phase 0 round-trip: nested `structured.courses`
    // survives the write path unchanged.
    it('persists a menus item carrying structured.courses', async () => {
      subprofiles.findOne.mockResolvedValue(
        makeSubprofile({ kind: SubprofileKind.Chef }),
      );
      const structured: ItemStructured = {
        courses: [
          {
            n: 'I',
            name: 'Starters',
            dishes: [{ title: 'Soup', note: null, marks: ['v'] }],
          },
        ],
      };
      await service.replaceSection('user-1', 'sp-1', 'menus', [
        { title: 'Tasting menu', structured },
      ]);
      const savedRows = (manager.save.mock.calls[0] as [SubprofileItem[]])[0];
      expect(savedRows[0]!.structured).toEqual(structured);
    });

    it('rejects a structured payload over the 16 KB jsonb cap', async () => {
      subprofiles.findOne.mockResolvedValue(
        makeSubprofile({ kind: SubprofileKind.Chef }),
      );
      const oversizedStructured: ItemStructured = {
        snippet: [Array.from({ length: 20_000 }, () => 'x').join('')],
      };
      await expect(
        service.replaceSection('user-1', 'sp-1', 'menus', [
          { title: 'Tasting menu', structured: oversizedStructured },
        ]),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    // Personas discovery Phase 5, Moment 6 (Decision §3): `replaceSection`
    // diffs the PERSONA-WIDE resolved-member collaborator set before vs.
    // after the save, then notifies newly-credited handles. That diff (the
    // dedup/self-exclusion business logic) now lives entirely in
    // `SubprofileCreditsService`, exercised against ITS real implementation
    // in `subprofile-credits.service.spec.ts` (dedup, untouched-other-section,
    // self-credit, co-owner-credit, exactly-one-per-handle). `credits` is a
    // plain jest mock in THIS file (see its declaration above), so the tests
    // below only assert what `SubprofilesService.replaceSection` itself is
    // responsible for: resolving the incoming collaborators, calling
    // `credits.computeNewlyCreditedHandles` with the right diff inputs, and
    // delegating to `credits.emitSubprofileCreditNotifications` if and only
    // if that diff came back non-empty.
    describe('subprofile_credit notification (delegation to SubprofileCreditsService)', () => {
      it('calls credits.computeNewlyCreditedHandles with the resolved incoming collaborators, and delegates to emitSubprofileCreditNotifications when it returns a newly-credited handle', async () => {
        const sp = makeSubprofile({
          id: 'sp-1',
          userId: 'user-1',
          displayName: 'Nightform',
          slug: 'nightform',
          handle: 'nightform',
          linkVisibility: SubprofileLinkVisibility.Unlinked,
        });
        subprofiles.findOne.mockResolvedValue(sp);
        handleRegistry.find.mockResolvedValue([
          makeHandleRow({ name: 'alice', userId: 'user-2' }),
        ]);
        profiles.find.mockResolvedValue([
          makeProfile({ userId: 'user-2', slug: 'alice' }),
        ]);
        // Overrides this file's inert file-wide default (see its declaration
        // above) for ONLY this test, so the emit branch genuinely fires
        // rather than passing because the mock can never return anything else.
        credits.computeNewlyCreditedHandles.mockResolvedValueOnce(['alice']);

        const savedItems = [
          { title: 'Collab track', collaborators: ['alice'] },
        ];
        await service.replaceSection(
          'user-1',
          'sp-1',
          'projects',
          savedItems,
        );

        expect(credits.computeNewlyCreditedHandles).toHaveBeenCalledWith(
          'sp-1',
          'user-1',
          SubprofileSection.Projects,
          new Map([
            [
              'alice',
              {
                handle: 'alice',
                type: 'member',
                name: 'Alice A',
                avatarUrl: null,
                slug: 'alice',
              },
            ],
          ]),
        );
        expect(credits.emitSubprofileCreditNotifications).toHaveBeenCalledTimes(1);
        expect(credits.emitSubprofileCreditNotifications).toHaveBeenCalledWith(
          sp,
          'sp-1',
          ['alice'],
          savedItems,
          [['alice']],
        );
      });

      it('skips credits.emitSubprofileCreditNotifications when computeNewlyCreditedHandles resolves no newly-credited handles (e.g. a re-save with unchanged collaborators)', async () => {
        const sp = makeSubprofile({
          id: 'sp-1',
          userId: 'user-1',
          displayName: 'Nightform',
          slug: 'nightform',
          handle: 'nightform',
          linkVisibility: SubprofileLinkVisibility.Unlinked,
        });
        subprofiles.findOne.mockResolvedValue(sp);
        handleRegistry.find.mockResolvedValue([
          makeHandleRow({ name: 'alice', userId: 'user-2' }),
        ]);
        profiles.find.mockResolvedValue([
          makeProfile({ userId: 'user-2', slug: 'alice' }),
        ]);
        // Left at this file's inert file-wide default ([]) — this is exactly
        // what a dedup'd re-save looks like from SubprofilesService's own
        // point of view: the diff came back empty, so there is nothing to
        // notify. The dedup logic itself is covered for real in
        // subprofile-credits.service.spec.ts.

        await service.replaceSection('user-1', 'sp-1', 'projects', [
          { title: 'Collab track', collaborators: ['alice'] },
        ]);

        expect(credits.computeNewlyCreditedHandles).toHaveBeenCalledWith(
          'sp-1',
          'user-1',
          SubprofileSection.Projects,
          expect.any(Map),
        );
        expect(credits.emitSubprofileCreditNotifications).not.toHaveBeenCalled();
      });

      it('swallows an emitSubprofileCreditNotifications rejection rather than failing the save (best-effort, post-commit)', async () => {
        const sp = makeSubprofile({
          id: 'sp-1',
          userId: 'user-1',
          displayName: 'Nightform',
          slug: 'nightform',
          handle: 'nightform',
          linkVisibility: SubprofileLinkVisibility.Unlinked,
        });
        subprofiles.findOne.mockResolvedValue(sp);
        handleRegistry.find.mockResolvedValue([
          makeHandleRow({ name: 'alice', userId: 'user-2' }),
        ]);
        profiles.find.mockResolvedValue([
          makeProfile({ userId: 'user-2', slug: 'alice' }),
        ]);
        credits.computeNewlyCreditedHandles.mockResolvedValueOnce(['alice']);
        credits.emitSubprofileCreditNotifications.mockRejectedValueOnce(
          new Error('notification fan-out failed'),
        );

        await expect(
          service.replaceSection('user-1', 'sp-1', 'projects', [
            { title: 'Collab track', collaborators: ['alice'] },
          ]),
        ).resolves.toBeDefined();
        expect(credits.emitSubprofileCreditNotifications).toHaveBeenCalledTimes(1);
      });
    });

    // Protect Your Work (revision history), Task 7: `recordItemRevision`
    // snapshots a matched existing row's PRE-save content into
    // `subprofile_item_revisions` (via the transaction `manager`, never
    // `itemRevisions` directly, see the constructor comment) whenever the
    // incoming payload changes it, then prunes that item's revisions to the
    // newest `REVISION_CAP` (30).
    describe('revision history (Protect Your Work)', () => {
      it('writes a revision when an existing item content changes on replace', async () => {
        subprofiles.findOne.mockResolvedValue(
          makeSubprofile({ kind: SubprofileKind.Developer }),
        );
        const existingRow = makeItem({
          id: 'it-1',
          section: SubprofileSection.Projects,
          title: 'A',
        });
        manager.find.mockImplementation((entity: unknown) =>
          entity === SubprofileItem
            ? Promise.resolve([existingRow])
            : Promise.resolve([]),
        );

        await service.replaceSection('user-1', 'sp-1', 'projects', [
          { title: 'B' },
        ]);

        const revisionCreateCall = manager.create.mock.calls.find(
          (call) => call[0] === SubprofileItemRevision,
        ) as [unknown, Partial<SubprofileItemRevision>] | undefined;
        expect(revisionCreateCall).toBeDefined();
        expect(revisionCreateCall![1].itemId).toBe('it-1');
        expect(revisionCreateCall![1].subprofileId).toBe('sp-1');
        expect(
          (revisionCreateCall![1].snapshot as unknown as { title: string })
            .title,
        ).toBe('A');
      });

      it('does not write a revision when content is unchanged', async () => {
        subprofiles.findOne.mockResolvedValue(
          makeSubprofile({ kind: SubprofileKind.Developer }),
        );
        const existingRow = makeItem({
          id: 'it-1',
          section: SubprofileSection.Projects,
          title: 'Same title',
        });
        manager.find.mockImplementation((entity: unknown) =>
          entity === SubprofileItem
            ? Promise.resolve([existingRow])
            : Promise.resolve([]),
        );

        await service.replaceSection('user-1', 'sp-1', 'projects', [
          { title: 'Same title' },
        ]);

        expect(
          manager.create.mock.calls.some(
            (call) => call[0] === SubprofileItemRevision,
          ),
        ).toBe(false);
      });

      it('prunes to at most 30 revisions per item', async () => {
        subprofiles.findOne.mockResolvedValue(
          makeSubprofile({ kind: SubprofileKind.Developer }),
        );
        const existingRow = makeItem({
          id: 'it-1',
          section: SubprofileSection.Projects,
          title: 'A',
        });
        // Simulates 31 revision rows already existing for this item AFTER
        // this save's own insert. The oldest one (index 0, ordered ASC by
        // `createdAt`) must be the one pruned.
        const oldestRevision = {
          id: 'rev-oldest',
          itemId: 'it-1',
          createdAt: new Date('2020-01-01T00:00:00Z'),
        };
        const newerRevisions = Array.from({ length: 30 }, (_, index) => ({
          id: `rev-${index}`,
          itemId: 'it-1',
          createdAt: new Date(2020, 0, index + 2),
        }));
        manager.find.mockImplementation((entity: unknown) => {
          if (entity === SubprofileItem) {
            return Promise.resolve([existingRow]);
          }
          if (entity === SubprofileItemRevision) {
            return Promise.resolve([oldestRevision, ...newerRevisions]);
          }
          return Promise.resolve([]);
        });

        await service.replaceSection('user-1', 'sp-1', 'projects', [
          { title: 'B' },
        ]);

        expect(manager.remove).toHaveBeenCalledWith([oldestRevision]);
      });

      // The DTO carries no `id`, so matching is positional (index in the
      // stored list vs. index in the incoming list). A pure reorder of the
      // SAME content is therefore a same-length payload where every slot's
      // content differs from what used to be at that slot, purely because a
      // different existing item now sits there. Skip-all-revisions logic
      // must recognize this via the whole-section multiset comparison, not
      // record a revision at every reordered slot.
      it('records no revision when items with distinct content are purely reordered', async () => {
        subprofiles.findOne.mockResolvedValue(
          makeSubprofile({ kind: SubprofileKind.Developer }),
        );
        const alpha = makeItem({
          id: 'it-alpha',
          section: SubprofileSection.Projects,
          title: 'Alpha',
          position: 0,
        });
        const beta = makeItem({
          id: 'it-beta',
          section: SubprofileSection.Projects,
          title: 'Beta',
          position: 1,
        });
        manager.find.mockImplementation((entity: unknown) =>
          entity === SubprofileItem
            ? Promise.resolve([alpha, beta])
            : Promise.resolve([]),
        );

        // Same two items, swapped: Beta now at position 0, Alpha at position 1.
        await service.replaceSection('user-1', 'sp-1', 'projects', [
          { title: 'Beta' },
          { title: 'Alpha' },
        ]);

        expect(
          manager.create.mock.calls.some(
            (call) => call[0] === SubprofileItemRevision,
          ),
        ).toBe(false);
      });
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

    // Personas redesign Phase 0 round-trip (design plan Task 7 Step 4):
    // `skinData.booker` survives the PATCH write path.
    it('persists skinData.booker', async () => {
      const sp = makeSubprofile();
      subprofiles.findOne.mockResolvedValue(sp);
      const skinData: SkinData = {
        booker: {
          fee: '$800–1200',
          rider: 'DI box, monitor wedge',
          press: 'press@example.com',
          contact: 'booking@example.com',
        },
      };
      await service.update('user-1', 'sp-1', { skinData });
      const saved = (subprofiles.save.mock.calls[0] as [Subprofile])[0];
      expect(saved.skinData).toEqual(skinData);
    });

    it('rejects a skinData payload over the 16 KB jsonb cap', async () => {
      const sp = makeSubprofile();
      subprofiles.findOne.mockResolvedValue(sp);
      const oversizedSkinData: SkinData = {
        colophon: Array.from({ length: 20_000 }, () => 'x').join(''),
      };
      await expect(
        service.update('user-1', 'sp-1', { skinData: oversizedSkinData }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // Personas redesign Phase 0 round-trip (design plan Task 7 Step 4): the new
  // fields, once on the entity, surface unchanged through the owner AND
  // public mappers — the same `SubprofileItem`/`Subprofile` shape the write
  // paths above persist.
  describe('Personas redesign Phase 0 mapper round-trip', () => {
    it('surfaces the new item scalars + structured through toSubprofileDTO and toPublicDTO', () => {
      const structured: ItemStructured = {
        courses: [{ n: 'I', name: 'Starters', dishes: [{ title: 'Soup' }] }],
      };
      const item = makeItem({
        section: SubprofileSection.Gigs,
        venue: 'The Grotto',
        doors: '8pm',
        ticketUrl: 'https://tickets.example/grotto',
        gigState: 'sold_out',
        structured,
      });
      const sp = makeSubprofile({
        skinData: {
          booker: {
            fee: '$800',
            rider: 'DI box',
            press: 'p@e.com',
            contact: 'b@e.com',
          },
        },
      });

      const ownerDto = toSubprofileDTO(sp, [item]);
      expect(ownerDto.items[0]!.venue).toBe('The Grotto');
      expect(ownerDto.items[0]!.gigState).toBe('sold_out');
      expect(ownerDto.items[0]!.structured).toEqual(structured);
      expect(ownerDto.skinData).toEqual(sp.skinData);

      const publicDto = toPublicDTO(sp, [item]);
      expect(publicDto.items[0]!.venue).toBe('The Grotto');
      expect(publicDto.items[0]!.gigState).toBe('sold_out');
      expect(publicDto.items[0]!.structured).toEqual(structured);
      expect(publicDto.skinData).toEqual(sp.skinData);
    });
  });

  // Protect Your Work (revision history), Task 8: list/get/restore. Mirrors
  // the `describe('getOwned', ...)` mock style directly above: the same
  // `subprofiles.findOne` + `members.findOne` pair gates every one of these,
  // since `listRevisions`/`getRevision`/`restoreRevision` all open with
  // `this.getOwned(userId, subprofileId)`, the SAME 404/403 owner/co-owner
  // check `replaceSection` uses.
  describe('item revisions (Protect Your Work, Task 8)', () => {
    beforeEach(() => {
      subprofiles.findOne.mockResolvedValue(
        makeSubprofile({ id: 'sp-1', userId: 'creator-1' }),
      );
      members.findOne.mockResolvedValue({
        subprofileId: 'sp-1',
        userId: 'user-1',
      });
    });

    it('lists revisions for an owned item, newest first', async () => {
      const olderRevision = {
        id: 'rev-older',
        itemId: 'it-1',
        subprofileId: 'sp-1',
        section: SubprofileSection.Projects,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        snapshot: { title: 'Old title' },
      };
      const newerRevision = {
        id: 'rev-newer',
        itemId: 'it-1',
        subprofileId: 'sp-1',
        section: SubprofileSection.Projects,
        createdAt: new Date('2026-02-01T00:00:00Z'),
        snapshot: { title: 'Newer title' },
      };
      // The repository is expected to be asked for DESC order; the mock
      // simply returns them already newest-first, as Postgres would.
      itemRevisions.find.mockResolvedValue([newerRevision, olderRevision]);

      const summaries = await service.listRevisions('user-1', 'sp-1', 'it-1');

      expect(itemRevisions.find).toHaveBeenCalledWith({
        where: { itemId: 'it-1', subprofileId: 'sp-1' },
        order: { createdAt: 'DESC' },
      });
      expect(summaries).toEqual([
        {
          id: 'rev-newer',
          createdAt: newerRevision.createdAt.toISOString(),
          title: 'Newer title',
        },
        {
          id: 'rev-older',
          createdAt: olderRevision.createdAt.toISOString(),
          title: 'Old title',
        },
      ]);
    });

    it('rejects a non-owner with 403', async () => {
      members.findOne.mockResolvedValue(null); // not a co-owner
      await expect(
        service.listRevisions('stranger-1', 'sp-1', 'it-1'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('404s getRevision when the revision does not belong to that item/subprofile', async () => {
      itemRevisions.findOne.mockResolvedValue(null);
      await expect(
        service.getRevision('user-1', 'sp-1', 'it-1', 'rev-missing'),
      ).rejects.toThrow(NotFoundException);
    });

    it('restores a revision non-destructively: applies the old snapshot AND keeps the pre-restore content as a new revision', async () => {
      const currentItem = makeItem({
        id: 'it-1',
        subprofileId: 'sp-1',
        title: 'B',
      });
      const revision = {
        id: 'rev-1',
        itemId: 'it-1',
        subprofileId: 'sp-1',
        section: SubprofileSection.Projects,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        // Built via the same `editableSnapshot` projection the service
        // itself writes on save, so the fixture matches what a real row
        // looks like.
        snapshot: editableSnapshot(makeItem({ title: 'A' })),
      };
      manager.findOne.mockImplementation((entity: unknown) => {
        if (entity === SubprofileItem) return Promise.resolve(currentItem);
        if (entity === SubprofileItemRevision)
          return Promise.resolve(revision);
        return Promise.resolve(null);
      });

      await service.restoreRevision('user-1', 'sp-1', 'it-1', 'rev-1');

      // Non-destructive: a new revision was recorded BEFORE the overwrite,
      // capturing the pre-restore title 'B'.
      const revisionCreateCall = manager.create.mock.calls.find(
        (call) => call[0] === SubprofileItemRevision,
      ) as [unknown, Partial<SubprofileItemRevision>] | undefined;
      expect(revisionCreateCall).toBeDefined();
      expect(
        (revisionCreateCall![1].snapshot as unknown as { title: string })
          .title,
      ).toBe('B');

      // The live item now carries the restored ('A') content, and its
      // identity/bookkeeping columns are untouched by the restore.
      const savedItemCall = manager.save.mock.calls.find(
        (call) => (call[0] as { id?: string }).id === 'it-1',
      ) as [SubprofileItem] | undefined;
      expect(savedItemCall).toBeDefined();
      expect(savedItemCall![0].title).toBe('A');
      expect(savedItemCall![0].id).toBe('it-1');
      expect(savedItemCall![0].subprofileId).toBe('sp-1');
    });

    it('404s restoreRevision when the item does not exist', async () => {
      manager.findOne.mockResolvedValue(null);
      await expect(
        service.restoreRevision('user-1', 'sp-1', 'missing-item', 'rev-1'),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
