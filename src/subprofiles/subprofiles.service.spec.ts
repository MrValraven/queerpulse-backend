import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import {
  resetImageUrlBaseForTesting,
  setImageUrlBase,
} from '../common/image-url';
import { getRepositoryToken } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, In, IsNull, Not } from 'typeorm';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import {
  AccessTier,
  Community,
} from '../communities/entities/community.entity';
import {
  Event,
  EventStatus,
  EventVisibility,
} from '../events/entities/event.entity';
import { Handle, HandleOwnerKind } from '../handles/entities/handle.entity';
import { HandlesService } from '../handles/handles.service';
import { MediaCropService } from '../media-crops/media-crops.service';
import { PersonaImageKeysService } from '../storage/persona-image-keys.service';
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
import { SubprofileAddressHistory } from './entities/subprofile-address-history.entity';
import { SubprofileEndorsement } from './entities/subprofile-endorsement.entity';
import { SubprofileFollower } from './entities/subprofile-follower.entity';
import { Identity, IdentityKind } from '../identities/entities/identity.entity';
import {
  SubprofileInvite,
  SubprofileInviteStatus,
} from './entities/subprofile-invite.entity';
import {
  eligibilityKey,
  SubprofileAffiliationEligibilityService,
} from './subprofile-affiliation-eligibility.service';
import { SubprofileMember } from './entities/subprofile-member.entity';
import { isSectionAllowed } from './subprofile-kinds';
import {
  sortByMemberPosition,
  toCardDTO,
  toPublicDTO,
  toSubprofileDTO,
} from './subprofile-response';
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
import { SubprofileUpdatesService } from './subprofile-updates.service';
import { SubprofilePublicReadService } from './subprofile-public-read.service';
import { editableSnapshot, SubprofilesService } from './subprofiles.service';
import { SUBPROFILE_DELETED } from './subprofile.events';

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
    availabilityUpdatedAt: null,
    ctaLabel: null,
    ctaUrl: null,
    linkVisibility: SubprofileLinkVisibility.Unlinked,
    visibility: SubprofileVisibility.Open,
    status: SubprofileStatus.Draft,
    position: 0,
    skinData: null,
    removedAt: null,
    editVersion: 0,
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
    pronunciation: null,
    tagline: null,
    bio: null,
    bioPt: null,
    location: null,
    avatarUrl: null,
    visibility: ProfileVisibility.Open,
    openTo: [],
    notHereFor: null,
    identities: [],
    discoverableIdentities: [],
    lookingFor: [],
    lookingForPublic: false,
    tags: [],
    discipline: [],
    profession: [],
    languages: [],
    vouchCount: 0,
    verified: false,
    verifiedAt: null,
    verifiedBy: null,
    privateNetwork: false,
    featuredConsent: false,
    photoVisible: true,
    hoodVisible: true,
    vouchersVisible: true,
    isAmbassadorTagVisible: true,
    now: null,
    nowUpdatedAt: null,
    hiddenUntil: null,
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
  it('returns [] for a linked persona with no handle, since the server derives one', () => {
    const sp = makeSubprofile({
      linkVisibility: SubprofileLinkVisibility.Linked,
      handle: null,
      avatarUrl: null,
      bio: null,
    });
    expect(validatePublish(sp, [])).toEqual([]);
  });

  it('runs only the handle checks for a linked persona with a typed handle', () => {
    const linkedWith = (handle: string) =>
      makeSubprofile({
        linkVisibility: SubprofileLinkVisibility.Linked,
        handle,
        avatarUrl: null,
        bio: null,
      });
    expect(validatePublish(linkedWith('x'), [])).toEqual(['handle_invalid']);
    expect(validatePublish(linkedWith('admin'), [])).toEqual([
      'handle_reserved',
    ]);
    expect(validatePublish(linkedWith('night-owl'), [], true)).toEqual([
      'handle_taken',
    ]);
    // No avatar or bio, and a handle that carries the creator slug: both fine.
    expect(
      validatePublish(linkedWith('robin-nightform'), [], false, 'robin'),
    ).toEqual([]);
  });

  // A linked persona's typed handle is a public `/p/` address, so it is
  // screened. The rest of its text keeps skipping the screen.
  it('flags blocked_terms for a linked persona whose typed handle carries a blocked term', () => {
    const blockedHandle = makeSubprofile({
      linkVisibility: SubprofileLinkVisibility.Linked,
      handle: `robin-${BLOCKED_TERMS[0]}`,
    });
    expect(validatePublish(blockedHandle, [])).toEqual(['blocked_terms']);
    const blockedBioOnly = makeSubprofile({
      linkVisibility: SubprofileLinkVisibility.Linked,
      handle: 'robin-nightform',
      bio: `a bio that says ${BLOCKED_TERMS[0]}`,
    });
    expect(validatePublish(blockedBioOnly, [])).toEqual([]);
  });

  it('flags handle_names_owner for an unlinked handle that carries the creator slug', () => {
    const sp = completeUnlinked({ handle: 'robin-after-dark' });
    expect(validatePublish(sp, [], false, 'robin')).toEqual([
      'handle_names_owner',
    ]);
    // Without the creator slug the check cannot run.
    expect(validatePublish(sp, [])).toEqual([]);
    // A handle that merely shares letters with the slug passes.
    const unrelated = completeUnlinked({ handle: 'robinson-crusoe' });
    expect(validatePublish(unrelated, [], false, 'robin')).toEqual([]);
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

  it('never flags content items: an otherwise-complete persona publishes empty', () => {
    const sp = completeUnlinked();
    // No content at all, and a links-only persona: both publish. Content is an
    // optional polish nudge on the frontend, never a gate (`MIN_CONTENT_ITEMS`
    // is advisory), so `not_enough_items` is no longer emitted.
    expect(validatePublish(sp, [])).toEqual([]);
    expect(
      validatePublish(sp, [
        makeItem({ id: 'link', section: SubprofileSection.Links }),
      ]),
    ).toEqual([]);
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

  it('allows each quest kind its own sections', () => {
    expect(isSectionAllowed('game_master', 'campaigns')).toBe(true);
    expect(isSectionAllowed('game_master', 'sessions')).toBe(true);
    expect(isSectionAllowed('cosplayer', 'cons')).toBe(true);
    expect(isSectionAllowed('cosplayer', 'campaigns')).toBe(false);
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

  // The owner's NAME rides the same linked-only rule as `ownerSlug`: it feeds
  // the FE's "Owner Name | Poet" title for a persona still named after its
  // profession, so leaking it for an unlinked (pseudonymous) persona would
  // undo that persona's anonymity.
  it('exposes the owner name for a LINKED persona', () => {
    const sp = makeSubprofile({
      handle: 'starlet',
      linkVisibility: SubprofileLinkVisibility.Linked,
    });
    const card = toCardDTO(sp, 0, [], 0, 'ana', new Map(), 'Ana Reis');
    expect(card.ownerName).toBe('Ana Reis');
  });

  it('never exposes the owner name for an UNLINKED persona, even when passed one', () => {
    const sp = makeSubprofile({
      handle: 'nightform',
      linkVisibility: SubprofileLinkVisibility.Unlinked,
    });
    const card = toCardDTO(sp, 0, [], 0, 'ana', new Map(), 'Ana Reis');
    expect(card.ownerName).toBeNull();
    expect(card.ownerSlug).toBeNull();
  });
});

// --- typed mock helpers ------------------------------------------------------
//
// Every fake below stubs only the handful of Repository/service methods its
// caller actually exercises (never a full `jest.Mocked<Repository<T>>`,
// which would require every member), and several of them return fixtures
// that only ever set the couple of fields the test/mock body actually reads
// rather than a complete row — so `RepoMockFn` leaves its argument shape as
// `unknown[]` (never invoked unsafely below) and takes the exact `Return`
// each fixture set needs; the "real, full entity" cases just pass the real
// entity's `Promise<Entity[] | Entity | null>` for `Return`. `ServiceMockFn`
// instead reads a method's args/return straight off an injected NestJS
// service class, so a mock's `.mock.calls[n]` can never drift from
// production the way a hand-written tuple type could.

type RepoMockFn<Return> = jest.Mock<Return, unknown[]>;

type ServiceMockFn<Class, Method extends keyof Class> = Class[Method] extends (
  ...args: infer Args
) => infer Return
  ? jest.Mock<Return, Args>
  : never;

// A `subprofile_members` row as this file's fixtures actually shape it:
// `subprofileId` is set by every fixture in this file, while every other
// column is fixture-dependent and often omitted.
type MemberRowFixture = Pick<SubprofileMember, 'subprofileId'> &
  Partial<SubprofileMember>;

// A `profiles` row as `profiles.findOne`'s fixtures actually shape it: every
// non-null fixture in this file sets exactly these four fields (the ones the
// owner-resolution code below reads) and nothing else.
type ProfileOwnerFixture = Pick<
  Profile,
  'slug' | 'userId' | 'firstName' | 'lastName'
> &
  Partial<Profile>;

// --- service (mocked repositories) ------------------------------------------

describe('SubprofilesService', () => {
  let service: SubprofilesService;
  // T17: re-homes unlinked persona images to persona-scoped keys. Defaults
  // to "nothing to re-home" so every test that does not stage it is
  // unaffected.
  let personaImageKeys: {
    rehomeForPersona: jest.Mock;
    rehomeForPersonaWrite: jest.Mock;
    rehomeUnlinkedPersona: jest.Mock;
    isMemberOfKeyPersona: jest.Mock;
    listKeysOf: jest.Mock;
    deleteObjects: jest.Mock;
  };
  let subprofiles: {
    // Every fixture fed to `find`/`findOne` in this file is either a
    // complete `makeSubprofile(...)` row or `null`/`[]`, so these carry the
    // real entity type (unlike `members`/`profiles` below, which also see
    // ad hoc partial fixtures).
    find: RepoMockFn<Promise<Subprofile[]>>;
    findOne: RepoMockFn<Promise<Subprofile | null>>;
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
    // Unlike `subprofiles` above, this file's `members.findOne` fixtures are
    // an inconsistent mix of `{ id }`-only and `{ subprofileId, userId }`-only
    // sentinels (only ever null-checked, never read field-by-field), so its
    // Return stays a genuine `Partial`. `find`'s fixtures always set
    // `subprofileId` (the field every consumer below actually reads).
    findOne: RepoMockFn<Promise<Partial<SubprofileMember> | null>>;
    find: RepoMockFn<Promise<MemberRowFixture[]>>;
    create: jest.Mock;
    save: jest.Mock;
    count: jest.Mock;
    delete: jest.Mock;
  };
  let profiles: {
    // `findOne`'s fixtures are always the same `{ slug, userId, firstName,
    // lastName }` shape (see `ProfileOwnerFixture`); `find`'s are always a
    // complete `makeProfile(...)` row.
    findOne: RepoMockFn<Promise<ProfileOwnerFixture | null>>;
    find: RepoMockFn<Promise<Profile[]>>;
  };
  let handleRegistry: { find: RepoMockFn<Promise<Handle[]>> };
  let notifications: { create: jest.Mock };
  let manager: {
    findOne: jest.Mock;
    find: jest.Mock;
    // The transaction manager stands in for TypeORM's `EntityManager`, whose
    // `create`/`save`/`count` are dispatched against a DIFFERENT entity
    // class per call site in this file (Subprofile, SubprofileMember,
    // SubprofileItem, SubprofileItemRevision) — there is no single Entity to
    // parameterize `RepoMockFn` with. `count`'s call sites all read its
    // result as a number, so that one keeps a concrete return type; `create`
    // and `save`'s call sites only ever read back `.mock.calls[n]` through
    // their own explicit `as [...]` casts (never assign the return value),
    // so `unknown` is the honest — not `any` — type for both.
    count: jest.Mock<Promise<number>, unknown[]>;
    delete: jest.Mock;
    remove: jest.Mock;
    create: jest.Mock<unknown, unknown[]>;
    save: jest.Mock<Promise<unknown>, unknown[]>;
    update: jest.Mock;
    query: jest.Mock;
    exists: jest.Mock;
  };
  // `manager` is the UNLOCKED manager (`dataSource.manager`), kept apart
  // from the transaction `manager` above so a test that stages the locked
  // re-read never changes what `publish` reads before its transaction.
  let dataSource: {
    transaction: jest.Mock;
    manager: { findOne: jest.Mock };
  };
  let blockFilter: {
    isBlockedEitherWay: ServiceMockFn<BlockFilterService, 'isBlockedEitherWay'>;
    excludeBlocked: jest.Mock;
    blockedUserIds: ServiceMockFn<BlockFilterService, 'blockedUserIds'>;
  };
  let contentModeration: {
    stateFor: ServiceMockFn<ContentModerationService, 'stateFor'>;
    statesFor: jest.Mock;
  };
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
    isMember: ServiceMockFn<SubprofileMembershipService, 'isMember'>;
    getOwned: ServiceMockFn<SubprofileMembershipService, 'getOwned'>;
    assertMember: ServiceMockFn<SubprofileMembershipService, 'assertMember'>;
    listMembers: jest.Mock;
    leave: ServiceMockFn<SubprofileMembershipService, 'leave'>;
    removeMember: jest.Mock;
    loadMemberCountsFor: ServiceMockFn<
      SubprofileMembershipService,
      'loadMemberCountsFor'
    >;
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
  let updates: {
    snapshotSectionTitles: jest.Mock;
    notifyFollowersOfNewItems: jest.Mock;
  };
  // Event/community lookups behind `replaceAffiliations`. Empty by default;
  // the "Part of" describe block below stages its own targets.
  let eventsRepository: { find: jest.Mock };
  let communitiesRepository: { find: jest.Mock };
  // "Part of" eligibility. Defaults to "no owners, nothing eligible", which
  // no pre-existing test reaches (none of them saves affiliations).
  let affiliationEligibility: {
    ownerIdsFor: jest.Mock;
    eligibleTargetKeys: jest.Mock;
    listOptions: jest.Mock;
  };
  // The `HandlesService` stub, read back from the testing module so specs can
  // order its calls against the persona row lock.
  let handlesService: {
    isTaken: jest.Mock;
    release: jest.Mock;
    rename: jest.Mock;
    stopForwardingFor: jest.Mock;
  };
  // A copy of the row `getOwned` last loaded, taken before the service
  // mutates it: what the locked re-read sees as committed when a test stages
  // no concurrent change.
  let committedRowAtLoad: Subprofile | undefined;

  beforeEach(async () => {
    committedRowAtLoad = undefined;
    subprofiles = {
      find: jest.fn<Promise<Subprofile[]>, unknown[]>().mockResolvedValue([]),
      findOne: jest
        .fn<Promise<Subprofile | null>, unknown[]>()
        .mockResolvedValue(null),
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
      findOne: jest
        .fn<Promise<Partial<SubprofileMember> | null>, unknown[]>()
        .mockResolvedValue({ id: 'member-1' }),
      find: jest
        .fn<Promise<MemberRowFixture[]>, unknown[]>()
        .mockResolvedValue([]),
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
      findOne: jest
        .fn<Promise<ProfileOwnerFixture | null>, unknown[]>()
        .mockResolvedValue(null),
      // Only reached by `resolveHandles` when `handleRegistry.find` returns at
      // least one `ownerKind: 'profile'` row — every pre-existing test leaves
      // `handleRegistry` at its `[]` default, so this stays unexercised for
      // them; the `subprofile_credit` tests below override it.
      find: jest.fn<Promise<Profile[]>, unknown[]>().mockResolvedValue([]),
    };
    // Backs `resolveHandles`'s handle→profile/persona lookups AND
    // `resolveMemberUserIdsByHandle`'s narrower handle→userId lookup.
    // Defaults to "no handles registered" so every pre-existing test (none of
    // which exercise collaboration credits) is unaffected.
    handleRegistry = {
      find: jest.fn<Promise<Handle[]>, unknown[]>().mockResolvedValue([]),
    };
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
      //
      // The `Subprofile` read is also the locked re-read every whole-entity
      // save takes (`saveEditUnderLock`). It returns a copy of the row
      // `getOwned` last loaded, as it was before the service mutated it, so
      // for every test that does not stage a concurrent change the committed
      // row equals the loaded one and the re-read changes nothing; the
      // creator-transfer race tests below override it with a row that moved
      // on.
      findOne: jest.fn().mockImplementation((entity: unknown) => {
        if (entity === Subprofile && committedRowAtLoad) {
          return Promise.resolve({ ...committedRowAtLoad });
        }
        if (entity === Subprofile) {
          const loads = subprofiles.findOne.mock.results;
          const lastLoad = loads[loads.length - 1];
          return lastLoad?.type === 'return'
            ? lastLoad.value
            : Promise.resolve(makeSubprofile());
        }
        return Promise.resolve(null);
      }),
      // `replaceSection`'s revision pruning (`recordItemRevision`) re-reads
      // `subprofile_item_revisions` for the item it just wrote a snapshot
      // for. Defaults to "none yet" so every pre-existing test (none of
      // which touch revisions) is unaffected; the revision-history tests
      // below override this per-case.
      find: jest.fn().mockResolvedValue([]),
      count: jest.fn<Promise<number>, unknown[]>().mockResolvedValue(2),
      delete: jest.fn().mockResolvedValue(undefined),
      remove: jest.fn().mockResolvedValue(undefined),
      create: jest
        .fn<unknown, unknown[]>()
        .mockImplementation((_entity: unknown, value: unknown) => ({
          ...(value as Record<string, unknown>),
        })),
      save: jest.fn<Promise<unknown>, unknown[]>().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      // Backs `create()`'s per-user advisory lock
      // (`pg_advisory_xact_lock`) taken at the top of its transaction.
      query: jest.fn().mockResolvedValue(undefined),
      // Backs the linked-draft handle derivation's "another subprofile row
      // already stores this name" check. Defaults to "no other row", so a
      // derived name is only skipped where a test stages one.
      exists: jest.fn().mockResolvedValue(false),
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
      // `publish` reads the persona creator's profile here before its claim
      // transaction. Every creator gets the profile slug `robin` by default,
      // so a linked persona `nightform` derives `robin-nightform`.
      manager: {
        findOne: jest
          .fn()
          .mockImplementation(
            (entity: unknown, options?: { where?: { userId?: string } }) =>
              Promise.resolve(
                entity === Profile
                  ? makeProfile({
                      userId: options?.where?.userId ?? 'user-1',
                      slug: 'robin',
                    })
                  : null,
              ),
          ),
      },
    };
    blockFilter = {
      isBlockedEitherWay: jest
        .fn<Promise<boolean>, [string, string]>()
        .mockResolvedValue(false),
      excludeBlocked: jest.fn(),
      // Only reached by `resolveHandles` when `handleRegistry.find` returns at
      // least one row — see the `profiles.find` comment above.
      blockedUserIds: jest
        .fn<Promise<Set<string>>, [string, string[]]>()
        .mockResolvedValue(new Set<string>()),
    };
    // Defaults to "fully visible" (no takedown row) so every pre-existing
    // test is unaffected; the `getByHandle`/`getBySlugForProfile` describe
    // blocks below override per-case.
    contentModeration = {
      stateFor: jest
        .fn<Promise<{ hidden: boolean; removed: boolean }>, [string, string]>()
        .mockResolvedValue({ hidden: false, removed: false }),
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
      isMember: jest
        .fn<Promise<boolean>, [string, string]>()
        .mockImplementation(async (userId: string, subprofileId: string) => {
          const row = await members.findOne({
            where: { subprofileId, userId },
            select: { id: true },
          });
          return row !== null;
        }),
      getOwned: jest.fn<Promise<Subprofile>, [string, string]>(),
      assertMember: jest.fn<Promise<Subprofile>, [string, string]>(),
      listMembers: jest.fn().mockResolvedValue([]),
      leave: jest.fn<Promise<void>, [string, string]>(),
      removeMember: jest.fn().mockResolvedValue(undefined),
      // Mirrors SubprofileMembershipService.loadMemberCountsFor's contract
      // (a grouped tally keyed by subprofileId) via members.find rather than
      // its real createQueryBuilder call, since the shared `members` mock
      // only implements the repository-style methods this file already uses.
      loadMemberCountsFor: jest
        .fn<Promise<Map<string, number>>, [string[]]>()
        .mockImplementation(async (subprofileIds: string[]) => {
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
        }),
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
        committedRowAtLoad = { ...sp };
        return sp;
      },
    );
    membership.assertMember.mockImplementation((userId: string, id: string) =>
      membership.getOwned(userId, id),
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
        // Persona takedowns are keyed by the persona id.
        const moderation = await contentModeration.stateFor(
          'subprofile',
          sp.id,
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
      resolveHandles: jest
        .fn()
        .mockImplementation(async (handleNames: string[], viewerId: string) => {
          const collaboratorByHandle = new Map<
            string,
            {
              handle: string;
              type: string;
              name: string;
              avatarUrl: string | null;
              slug: string | null;
            }
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
        }),
      resolveCollaboratorsFor: jest.fn().mockResolvedValue(new Map()),
      loadItemsFor: jest.fn().mockResolvedValue(new Map()),
      loadSocialLinksFor: jest.fn().mockResolvedValue(new Map()),
      resolveAffiliationsFor: jest.fn().mockResolvedValue(new Map()),
      listForProfile: jest
        .fn()
        .mockImplementation(async (ownerSlug: string, viewerId: string) => {
          const profile = await profiles.findOne({
            where: { slug: ownerSlug },
          });
          if (!profile) {
            throw new NotFoundException('Profile not found');
          }
          if (await blockFilter.isBlockedEitherWay(viewerId, profile.userId)) {
            return [];
          }
          // `position` is selected alongside `subprofileId` here for the same
          // reason production selects it: the nested list is ordered by the
          // VIEWED profile owner's own arrangement
          // (`subprofile_members.position`), read off the membership rows
          // this query already fetches.
          const memberRows: MemberRowFixture[] = await members.find({
            where: { userId: profile.userId },
            select: { subprofileId: true, position: true },
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
          const memberPositionsBySubprofileId = new Map(
            memberRows.flatMap((row) =>
              row.position === undefined
                ? []
                : [[row.subprofileId, row.position] as const],
            ),
          );
          const owner = {
            slug: profile.slug,
            name: `${profile.firstName} ${profile.lastName}`.trim(),
          };
          return sortByMemberPosition(
            linkedSps,
            memberPositionsBySubprofileId,
          ).map((sp) => toPublicDTO(sp, [], owner));
        }),
      // Mirrors SubprofilePublicReadService.getByHandle: both link kinds
      // resolve by handle, the published holder first (a draft may share the
      // name), and a linked persona carries its creator as the owner.
      getByHandle: jest
        .fn()
        .mockImplementation(
          async (handle: string, viewer: CurrentUserData | undefined) => {
            const sp =
              (await subprofiles.findOne({
                where: { handle, status: SubprofileStatus.Published },
              })) ?? (await subprofiles.findOne({ where: { handle } }));
            if (!sp) {
              throw new NotFoundException('Subprofile not found');
            }
            const creatorProfile =
              sp.linkVisibility === SubprofileLinkVisibility.Linked
                ? await profiles.findOne({ where: { userId: sp.userId } })
                : null;
            const owner = creatorProfile
              ? {
                  slug: creatorProfile.slug,
                  name: `${creatorProfile.firstName} ${creatorProfile.lastName}`.trim(),
                }
              : undefined;
            return buildPublicView(sp, viewer, owner);
          },
        ),
      getBySlugForProfile: jest
        .fn()
        .mockImplementation(
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
    // `replaceSection`/`insertItemsAtTop` snapshot the section before the write
    // and tell followers after it; the follower fan-out itself is covered by
    // `subprofile-updates.service.spec.ts`.
    updates = {
      snapshotSectionTitles: jest.fn().mockResolvedValue([]),
      notifyFollowersOfNewItems: jest.fn().mockResolvedValue(undefined),
    };
    eventsRepository = { find: jest.fn().mockResolvedValue([]) };
    communitiesRepository = { find: jest.fn().mockResolvedValue([]) };
    affiliationEligibility = {
      ownerIdsFor: jest.fn().mockResolvedValue(new Map<string, string[]>()),
      eligibleTargetKeys: jest.fn().mockResolvedValue(new Set<string>()),
      listOptions: jest.fn().mockResolvedValue([]),
    };

    personaImageKeys = {
      rehomeForPersona: jest.fn().mockResolvedValue(new Map()),
      rehomeForPersonaWrite: jest.fn().mockResolvedValue(new Map()),
      rehomeUnlinkedPersona: jest.fn().mockResolvedValue(new Map()),
      isMemberOfKeyPersona: jest.fn().mockResolvedValue(false),
      listKeysOf: jest.fn().mockResolvedValue([]),
      deleteObjects: jest.fn().mockResolvedValue(undefined),
    };
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
        { provide: getRepositoryToken(Event), useValue: eventsRepository },
        {
          provide: getRepositoryToken(Community),
          useValue: communitiesRepository,
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
            stopForwardingFor: jest.fn().mockResolvedValue(undefined),
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
        { provide: SubprofileUpdatesService, useValue: updates },
        { provide: SubprofilePublicReadService, useValue: publicRead },
        {
          provide: SubprofileAffiliationEligibilityService,
          useValue: affiliationEligibility,
        },
        { provide: EventEmitter2, useValue: eventEmitter },
        {
          provide: MediaCropService,
          useValue: { getMany: jest.fn().mockResolvedValue(new Map()) },
        },
        { provide: PersonaImageKeysService, useValue: personaImageKeys },
      ],
    }).compile();
    service = module.get(SubprofilesService);
    handlesService = module.get(HandlesService);
    // Mappers resolve stored image keys through `toImageUrl`, which throws
    // `Service temporarily unavailable` when the base was never wired. Only
    // storage-key fixtures reach it (the M1 foreign-upload cases).
    setImageUrlBase('https://api.test');
  });

  afterEach(() => {
    resetImageUrlBaseForTesting();
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
        makeSubprofile({ slug: 'nightform' }),
        makeSubprofile({ slug: 'nightform-2' }),
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

    // A new persona is a linked draft, so it stores its derived
    // `<creatorSlug>-<personaSlug>` handle from the start. Drafts never claim
    // a registry row, so nothing is renamed or released.
    describe('linked draft handle', () => {
      const stageCreatorProfileInTransaction = (slug: string) => {
        manager.findOne.mockImplementation(
          (entity: unknown, options?: { where?: { userId?: string } }) =>
            Promise.resolve(
              entity === Profile
                ? makeProfile({ userId: options?.where?.userId, slug })
                : null,
            ),
        );
      };

      it('stores the derived handle on the new linked draft and claims no registry row', async () => {
        subprofiles.find.mockResolvedValue([]);
        stageCreatorProfileInTransaction('robin');

        const dto = await service.create('user-1', {
          kind: SubprofileKind.Musician,
          displayName: 'Nightform',
        });

        const saved = (manager.save.mock.calls[0] as [Subprofile])[0];
        expect(saved).toMatchObject({
          linkVisibility: SubprofileLinkVisibility.Linked,
          handle: 'robin-nightform',
        });
        expect(manager.findOne).toHaveBeenCalledWith(Profile, {
          where: { userId: 'user-1' },
        });
        // The row is not inserted yet, so no own name or row is left out.
        expect(handlesService.isTaken).toHaveBeenCalledWith(
          manager,
          'robin-nightform',
          undefined,
        );
        expect(manager.exists).toHaveBeenCalledWith(Subprofile, {
          where: { handle: 'robin-nightform' },
        });
        expect(handlesService.rename).not.toHaveBeenCalled();
        expect(handlesService.release).not.toHaveBeenCalled();
        expect(dto.handle).toBe('robin-nightform');
      });

      it('skips a derived name another subprofile row already stores', async () => {
        subprofiles.find.mockResolvedValue([]);
        stageCreatorProfileInTransaction('robin');
        manager.exists.mockImplementation(
          (_entity: unknown, options: { where: { handle: string } }) =>
            Promise.resolve(options.where.handle === 'robin-nightform'),
        );

        await service.create('user-1', {
          kind: SubprofileKind.Musician,
          displayName: 'Nightform',
        });

        const saved = (manager.save.mock.calls[0] as [Subprofile])[0];
        expect(saved.handle).toBe('robin-nightform-2');
      });

      it('leaves the handle null and still saves when the creator has no profile', async () => {
        subprofiles.find.mockResolvedValue([]);

        await service.create('user-1', {
          kind: SubprofileKind.Musician,
          displayName: 'Nightform',
        });

        const saved = (manager.save.mock.calls[0] as [Subprofile])[0];
        expect(saved.handle).toBeNull();
        expect(manager.save).toHaveBeenCalledTimes(2);
        expect(handlesService.isTaken).not.toHaveBeenCalled();
      });
    });
  });

  describe('getOwned', () => {
    it('allows any member (not just the creator)', async () => {
      // creatorId owns sp1; memberId is a co-owner via subprofile_members.
      subprofiles.findOne.mockResolvedValue(
        makeSubprofile({ id: 'sp1', userId: 'creatorId' }),
      );
      members.findOne.mockResolvedValue({
        subprofileId: 'sp1',
        userId: 'memberId',
      });
      await expect(service.getOwned('memberId', 'sp1')).resolves.toMatchObject({
        id: 'sp1',
      });
    });

    it('rejects a non-member with 403', async () => {
      subprofiles.findOne.mockResolvedValue(
        makeSubprofile({ id: 'sp1', userId: 'creatorId' }),
      );
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
        // `position` rides along on this same query: per-member ordering
        // costs no extra round trip.
        select: { subprofileId: true, position: true },
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
      members.find.mockImplementation((rawOptions: unknown) => {
        const options = rawOptions as { where: { userId?: string } };
        if (options.where.userId) {
          return Promise.resolve([
            { subprofileId: 'sp-solo', userId: 'user-1' },
          ]);
        }
        return Promise.resolve([{ subprofileId: 'sp-solo' }]);
      });
      subprofiles.find.mockResolvedValue([
        makeSubprofile({ id: 'sp-solo', userId: 'user-1' }),
      ]);
      const result = await service.listMine('user-1');
      expect(result.find((view) => view.id === 'sp-solo')?.memberCount).toBe(1);
    });

    it('reports the true co-owner headcount for a co-owned persona, via ONE grouped query', async () => {
      members.find.mockImplementation((rawOptions: unknown) => {
        const options = rawOptions as { where: { userId?: string } };
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
      });
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

    // Per-member persona ordering (`subprofile_members.position`). The
    // persona rows come back from the database in their own (now frozen)
    // `subprofiles.position` order; what the caller sees is THEIR arrangement
    // on top of that.
    it('returns personas in the caller’s own member order, not the persona-row order', async () => {
      members.find.mockImplementation((rawOptions: unknown) => {
        const options = rawOptions as { where: { userId?: string } };
        if (options.where.userId) {
          // Deliberately the reverse of the order the persona rows arrive in
          // below, so a pass here cannot be the database order in disguise.
          return Promise.resolve([
            { subprofileId: 'sp-first', userId: 'user-1', position: 2 },
            { subprofileId: 'sp-second', userId: 'user-1', position: 1 },
            { subprofileId: 'sp-third', userId: 'user-1', position: 0 },
          ]);
        }
        return Promise.resolve([
          { subprofileId: 'sp-first' },
          { subprofileId: 'sp-second' },
          { subprofileId: 'sp-third' },
        ]);
      });
      subprofiles.find.mockResolvedValue([
        makeSubprofile({ id: 'sp-first', createdAt: new Date('2026-01-01') }),
        makeSubprofile({ id: 'sp-second', createdAt: new Date('2026-01-02') }),
        makeSubprofile({ id: 'sp-third', createdAt: new Date('2026-01-03') }),
      ]);
      const result = await service.listMine('user-1');
      expect(result.map((view) => view.id)).toEqual([
        'sp-third',
        'sp-second',
        'sp-first',
      ]);
      // The DTO's `position` is the MEMBER position, so it agrees with the
      // order the list came back in.
      expect(result.map((view) => view.position)).toEqual([0, 1, 2]);
    });

    // `createdAt` ASC is the deterministic tiebreak, which matters while a
    // reorder is in flight and for rows still sitting on the migration's
    // backfill.
    it('breaks a member-position tie on createdAt ASC', async () => {
      members.find.mockImplementation((rawOptions: unknown) => {
        const options = rawOptions as { where: { userId?: string } };
        if (options.where.userId) {
          return Promise.resolve([
            { subprofileId: 'sp-newer', userId: 'user-1', position: 0 },
            { subprofileId: 'sp-older', userId: 'user-1', position: 0 },
          ]);
        }
        return Promise.resolve([
          { subprofileId: 'sp-newer' },
          { subprofileId: 'sp-older' },
        ]);
      });
      subprofiles.find.mockResolvedValue([
        makeSubprofile({ id: 'sp-newer', createdAt: new Date('2026-02-02') }),
        makeSubprofile({ id: 'sp-older', createdAt: new Date('2026-01-01') }),
      ]);
      const result = await service.listMine('user-1');
      expect(result.map((view) => view.id)).toEqual(['sp-older', 'sp-newer']);
    });
  });

  // Per-member persona ordering. `reorderMine` is the ONE writer of ordering
  // (`position` came off `UpdateSubprofileDTO` in the same change), and it
  // writes `subprofile_members.position` so a co-owner arranging their own
  // profile never touches their collaborator's.
  describe('reorderMine', () => {
    const membershipRows = [
      { id: 'member-a', subprofileId: 'sp-a', userId: 'user-1' },
      { id: 'member-b', subprofileId: 'sp-b', userId: 'user-1' },
      { id: 'member-c', subprofileId: 'sp-c', userId: 'user-1' },
    ];

    it('writes position = index onto every member row, in one transaction', async () => {
      members.find.mockResolvedValue(membershipRows);
      await service.reorderMine('user-1', ['sp-c', 'sp-a', 'sp-b']);
      expect(members.find).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
        select: { id: true, subprofileId: true },
      });
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      // Addressed by the MEMBERSHIP row's primary key, so a co-owned
      // persona's other owners keep the order they chose.
      expect(manager.update.mock.calls).toEqual([
        [SubprofileMember, { id: 'member-c' }, { position: 0 }],
        [SubprofileMember, { id: 'member-a' }, { position: 1 }],
        [SubprofileMember, { id: 'member-b' }, { position: 2 }],
      ]);
    });

    it('rejects a list that is not the same length as the membership set', async () => {
      members.find.mockResolvedValue(membershipRows);
      await expect(
        service.reorderMine('user-1', ['sp-a', 'sp-b']),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.reorderMine('user-1', ['sp-a', 'sp-b']),
      ).rejects.toThrow(
        'ids must list every one of your personas exactly once (expected 3, received 2)',
      );
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('rejects a duplicate id', async () => {
      members.find.mockResolvedValue(membershipRows);
      // Right length, so only the duplicate check can catch this one.
      await expect(
        service.reorderMine('user-1', ['sp-a', 'sp-a', 'sp-b']),
      ).rejects.toThrow('ids must not contain duplicates');
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('rejects an id the caller does not belong to', async () => {
      members.find.mockResolvedValue(membershipRows);
      // Right length and no duplicates: `sp-someone-elses` stands in for a
      // stale client cache or a probe at another member's persona. Either way
      // it writes nothing, and the message names the caller's own list rather
      // than saying whether that id exists.
      await expect(
        service.reorderMine('user-1', ['sp-a', 'sp-b', 'sp-someone-elses']),
      ).rejects.toThrow(
        'ids must list every one of your personas exactly once and nothing else',
      );
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('accepts an empty list from a member who holds no personas, as a no-op', async () => {
      members.find.mockResolvedValue([]);
      await expect(
        service.reorderMine('lonely-user', []),
      ).resolves.toBeUndefined();
      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(manager.update).not.toHaveBeenCalled();
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
      // The CREATOR's profile, resolved by the batched creator lookup so the
      // card can be addressed at `/members/<creator>/<slug>` (ENG-153). Without
      // it the card carried the viewed co-owner's slug, which 404s, or opened
      // that co-owner's own same-slug persona instead.
      profiles.find.mockResolvedValue([
        makeProfile({
          userId: 'creator-1',
          slug: 'creator-one',
          firstName: 'Creator',
          lastName: 'One',
        }),
      ]);
      const result = await service.listForProfile('viewed-member', 'viewer-id');
      expect(members.find).toHaveBeenCalledWith({
        where: { userId: 'viewed-user-id' },
        // `position` rides along on this same query: per-member ordering
        // costs no extra round trip.
        select: { subprofileId: true, position: true },
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
      // The owner ref is the CREATOR's, never the co-owner whose profile is
      // being viewed: `ownerSlug` is what builds `/members/:ownerSlug/:slug`,
      // and the nested route resolves that pair against the creator alone.
      const coOwnedView = result.find((view) => view.slug === 'nightform');
      expect(coOwnedView?.ownerSlug).toBe('creator-one');
      expect(coOwnedView?.ownerName).toBe('Creator One');
      expect(profiles.find).toHaveBeenCalledWith({
        where: { userId: In(['creator-1']) },
      });
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

    it('queries by handle alone for both link kinds, the published holder first', async () => {
      subprofiles.findOne.mockResolvedValue(null);
      await service
        .getByHandle('nightform', makeViewer())
        .catch(() => undefined);
      expect(subprofiles.findOne).toHaveBeenNthCalledWith(1, {
        where: { handle: 'nightform', status: SubprofileStatus.Published },
      });
      expect(subprofiles.findOne).toHaveBeenNthCalledWith(2, {
        where: { handle: 'nightform' },
      });
    });

    it('resolves a published linked persona by its handle, with its creator as owner', async () => {
      subprofiles.findOne.mockResolvedValue(
        makeSubprofile({
          handle: 'robin-nightform',
          linkVisibility: SubprofileLinkVisibility.Linked,
          status: SubprofileStatus.Published,
        }),
      );
      profiles.findOne.mockResolvedValue({
        slug: 'robin',
        userId: 'user-1',
        firstName: 'Robin',
        lastName: 'Reyes',
      });
      members.findOne.mockResolvedValue(null);

      const dto = await service.getByHandle('robin-nightform', makeViewer());

      expect(dto.status).toBe(SubprofileStatus.Published);
      expect(dto).toMatchObject({ ownerSlug: 'robin' });
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

  // M1 (storage-key impersonation): a storage key embeds its uploader's id, and
  // the interceptor rejects a body that references a foreign key — EXCEPT for an
  // enumerated shared handler (a co-owned persona is editable by more than one
  // member), where the resolved-URL form is passed through and the real decision
  // is delegated here. The rule enforced by `assertNoForeignUploadIntroduced`: a
  // foreign upload is allowed ONLY when it is the value ALREADY stored on the
  // persona (a genuine no-op re-save by a collaborator); pointing a field at a
  // NEW foreign upload is refused, exactly as the interceptor would for a
  // single-editor surface.
  describe('foreign upload ownership (M1)', () => {
    const REQUESTER_ID = '11111111-1111-1111-1111-111111111111';
    const OTHER_ID = '22222222-2222-2222-2222-222222222222';
    const FILE_SEGMENT = '33333333-3333-3333-3333-333333333333';
    // A well-formed key whose embedded owner segment is NOT the requester.
    const FOREIGN_KEY = `avatars/${OTHER_ID}/${FILE_SEGMENT}.jpg`;

    it('update rejects an avatar key the persona does not already carry', async () => {
      subprofiles.findOne.mockResolvedValue(
        makeSubprofile({ userId: REQUESTER_ID, avatarUrl: null }),
      );
      await expect(
        service.update(REQUESTER_ID, 'sp-1', { avatarUrl: FOREIGN_KEY }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('update allows re-saving the foreign avatar key already stored (co-owner no-op)', async () => {
      subprofiles.findOne.mockResolvedValue(
        makeSubprofile({ userId: REQUESTER_ID, avatarUrl: FOREIGN_KEY }),
      );
      await expect(
        service.update(REQUESTER_ID, 'sp-1', { avatarUrl: FOREIGN_KEY }),
      ).resolves.toBeDefined();
    });

    it('replaceSection rejects an item image the section does not already hold', async () => {
      subprofiles.findOne.mockResolvedValue(
        makeSubprofile({
          userId: REQUESTER_ID,
          kind: SubprofileKind.Developer,
        }),
      );
      manager.find.mockImplementation((entity: unknown) =>
        entity === SubprofileItem ? Promise.resolve([]) : Promise.resolve([]),
      );
      await expect(
        service.replaceSection(REQUESTER_ID, 'sp-1', 'projects', [
          { title: 'x', imageUrl: FOREIGN_KEY },
        ]),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('replaceSection allows re-saving an item image the section already holds', async () => {
      subprofiles.findOne.mockResolvedValue(
        makeSubprofile({
          userId: REQUESTER_ID,
          kind: SubprofileKind.Developer,
        }),
      );
      const stored = makeItem({
        id: 'it-1',
        section: SubprofileSection.Projects,
        imageUrl: FOREIGN_KEY,
        position: 0,
      });
      manager.find.mockImplementation((entity: unknown) =>
        entity === SubprofileItem
          ? Promise.resolve([stored])
          : Promise.resolve([]),
      );
      await expect(
        service.replaceSection(REQUESTER_ID, 'sp-1', 'projects', [
          { title: 'x', imageUrl: FOREIGN_KEY },
        ]),
      ).resolves.toBeDefined();
    });
  });

  // T17: an unlinked persona's images live under persona-scoped keys
  // (`persona/<uuid>/<uuid><ext>`) that carry no user id.
  describe('persona-scoped image keys (T17)', () => {
    const REQUESTER_ID = '11111111-1111-1111-1111-111111111111';
    const FILE_SEGMENT = '33333333-3333-3333-3333-333333333333';
    const OWN_UPLOAD = `avatars/${REQUESTER_ID}/${FILE_SEGMENT}.jpg`;
    const PERSONA_KEY = `persona/${FILE_SEGMENT}/${FILE_SEGMENT}.jpg`;
    const OTHER_PERSONA_KEY = `persona/${REQUESTER_ID}/${FILE_SEGMENT}.png`;
    const FRESH_KEY = `persona/${REQUESTER_ID}/${REQUESTER_ID}.png`;

    it('update re-homes a new avatar under the row lock, on the unlinked state it saves', async () => {
      subprofiles.findOne.mockResolvedValue(
        makeSubprofile({
          userId: REQUESTER_ID,
          linkVisibility: SubprofileLinkVisibility.Unlinked,
        }),
      );
      personaImageKeys.rehomeForPersona.mockResolvedValue(
        new Map([[OWN_UPLOAD, PERSONA_KEY]]),
      );

      await service.update(REQUESTER_ID, 'sp-1', { avatarUrl: OWN_UPLOAD });

      expect(personaImageKeys.rehomeForPersona).toHaveBeenCalledWith(
        manager,
        'sp-1',
        [OWN_UPLOAD, null],
        { isUnlinked: true },
      );
      const lockOrder = manager.findOne.mock.invocationCallOrder[0] ?? 0;
      const rehomeOrder =
        personaImageKeys.rehomeForPersona.mock.invocationCallOrder[0] ?? 0;
      const saveOrder = manager.save.mock.invocationCallOrder[0] ?? 0;
      expect(lockOrder).toBeLessThan(rehomeOrder);
      expect(rehomeOrder).toBeLessThan(saveOrder);
      const saved = (manager.save.mock.calls[0] as [Subprofile])[0];
      expect(saved.avatarUrl).toBe(PERSONA_KEY);
    });

    it('update asks for the linked scheme on a linked persona', async () => {
      subprofiles.findOne.mockResolvedValue(
        makeSubprofile({
          userId: REQUESTER_ID,
          linkVisibility: SubprofileLinkVisibility.Linked,
          handle: 'robin-nightform',
        }),
      );

      await service.update(REQUESTER_ID, 'sp-1', { avatarUrl: OWN_UPLOAD });

      expect(personaImageKeys.rehomeForPersona).toHaveBeenCalledWith(
        manager,
        'sp-1',
        [OWN_UPLOAD, null],
        { isUnlinked: false },
      );
      const saved = (manager.save.mock.calls[0] as [Subprofile])[0];
      expect(saved.avatarUrl).toBe(OWN_UPLOAD);
    });

    it('unlinking gives every image a fresh key in the switch transaction, under the fresh id', async () => {
      subprofiles.findOne.mockResolvedValue(
        makeSubprofile({
          linkVisibility: SubprofileLinkVisibility.Linked,
          status: SubprofileStatus.Published,
          handle: 'robin-nightform',
        }),
      );
      // The service mutates `sp` (its id included) after the call, so the id
      // is captured at call time.
      const rehomedIds: string[] = [];
      personaImageKeys.rehomeUnlinkedPersona.mockImplementation(
        (_manager: unknown, persona: Subprofile) => {
          rehomedIds.push(persona.id);
          return Promise.resolve(new Map());
        },
      );

      await service.update('user-1', 'sp-1', {
        linkVisibility: SubprofileLinkVisibility.Unlinked,
      });

      expect(personaImageKeys.rehomeUnlinkedPersona).toHaveBeenCalledTimes(1);
      const [rehomeManager, , mode] = personaImageKeys.rehomeUnlinkedPersona
        .mock.calls[0] as [unknown, Subprofile, string];
      expect(rehomeManager).toBe(manager);
      expect(mode).toBe('unlink');
      const saved = (manager.save.mock.calls[0] as [Subprofile])[0];
      expect(saved.id).not.toBe('sp-1');
      expect(rehomedIds).toEqual([saved.id]);
      const rehomeOrder =
        personaImageKeys.rehomeUnlinkedPersona.mock.invocationCallOrder[0] ?? 0;
      const saveOrder = manager.save.mock.invocationCallOrder[0] ?? 0;
      expect(rehomeOrder).toBeLessThan(saveOrder);
    });

    it('replaceSection stores item images through the in-lock re-home', async () => {
      subprofiles.findOne.mockResolvedValue(
        makeSubprofile({
          userId: REQUESTER_ID,
          kind: SubprofileKind.Developer,
        }),
      );
      manager.find.mockResolvedValue([]);
      personaImageKeys.rehomeForPersonaWrite.mockResolvedValue(
        new Map([[OWN_UPLOAD, PERSONA_KEY]]),
      );

      await service.replaceSection(REQUESTER_ID, 'sp-1', 'projects', [
        { title: 'x', imageUrl: OWN_UPLOAD },
      ]);

      expect(personaImageKeys.rehomeForPersonaWrite).toHaveBeenCalledWith(
        manager,
        'sp-1',
        [OWN_UPLOAD],
      );
      const [savedRows] = manager.save.mock.calls[0] as [SubprofileItem[]];
      expect(savedRows[0]?.imageUrl).toBe(PERSONA_KEY);
    });

    it('update refuses a persona-scoped key of a persona the requester does not belong to', async () => {
      subprofiles.findOne.mockResolvedValue(
        makeSubprofile({ userId: REQUESTER_ID, avatarUrl: PERSONA_KEY }),
      );
      personaImageKeys.isMemberOfKeyPersona.mockResolvedValue(false);

      await expect(
        service.update(REQUESTER_ID, 'sp-1', { coverUrl: OTHER_PERSONA_KEY }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(personaImageKeys.isMemberOfKeyPersona).toHaveBeenCalledWith(
        OTHER_PERSONA_KEY,
        REQUESTER_ID,
      );
    });

    // Copying your own persona: the other persona's key is accepted, then
    // saved as a fresh key of this persona's own.
    it("update accepts another persona's key from one of its members and saves a fresh copy", async () => {
      subprofiles.findOne.mockResolvedValue(
        makeSubprofile({ userId: REQUESTER_ID }),
      );
      personaImageKeys.isMemberOfKeyPersona.mockResolvedValue(true);
      personaImageKeys.rehomeForPersona.mockResolvedValue(
        new Map([[OTHER_PERSONA_KEY, FRESH_KEY]]),
      );

      await service.update(REQUESTER_ID, 'sp-1', {
        coverUrl: OTHER_PERSONA_KEY,
      });

      const saved = (manager.save.mock.calls[0] as [Subprofile])[0];
      expect(saved.coverUrl).toBe(FRESH_KEY);
    });

    it('update allows re-saving the persona-scoped key already stored', async () => {
      subprofiles.findOne.mockResolvedValue(
        makeSubprofile({ userId: REQUESTER_ID, avatarUrl: PERSONA_KEY }),
      );

      await expect(
        service.update(REQUESTER_ID, 'sp-1', { avatarUrl: PERSONA_KEY }),
      ).resolves.toBeDefined();
      expect(personaImageKeys.isMemberOfKeyPersona).not.toHaveBeenCalled();
    });

    it("remove deletes the persona's own images only after the delete commits", async () => {
      subprofiles.findOne.mockResolvedValue(makeSubprofile());
      personaImageKeys.listKeysOf.mockResolvedValue([PERSONA_KEY]);

      await service.remove('user-1', 'sp-1');

      expect(personaImageKeys.listKeysOf).toHaveBeenCalledWith(manager, 'sp-1');
      expect(personaImageKeys.deleteObjects).toHaveBeenCalledWith([
        PERSONA_KEY,
      ]);
      const listOrder =
        personaImageKeys.listKeysOf.mock.invocationCallOrder[0] ?? 0;
      const removeOrder = manager.remove.mock.invocationCallOrder[0] ?? 0;
      const deleteOrder =
        personaImageKeys.deleteObjects.mock.invocationCallOrder[0] ?? 0;
      expect(listOrder).toBeLessThan(removeOrder);
      expect(removeOrder).toBeLessThan(deleteOrder);
    });
  });

  // Persona feed import: publishing podcast episodes inserts server-built
  // items at the TOP of a section, under the same persona lock and
  // edit-version bump every editor write takes.
  describe('insertItemsAtTop', () => {
    const fields = (title: string) => ({
      title,
      subtitle: null,
      description: null,
      url: null,
      imageUrl: null,
      date: '2026-09',
      meta: '48 min',
    });
    const stageSectionCount = (itemCount: number) => {
      manager.count.mockImplementation((entity: unknown) =>
        Promise.resolve(entity === SubprofileItem ? itemCount : 1),
      );
    };

    beforeEach(() => {
      subprofiles.findOne.mockResolvedValue(
        makeSubprofile({ kind: SubprofileKind.Developer, editVersion: 4 }),
      );
      manager.save.mockImplementation((rows: unknown) =>
        Promise.resolve(
          (rows as Record<string, unknown>[]).map((row, index) => ({
            ...row,
            id: `item-${index}`,
          })),
        ),
      );
      updates.snapshotSectionTitles.mockResolvedValue(['Old A', 'Old B']);
    });

    it('shifts the section down and inserts the candidates at positions 0..k-1', async () => {
      stageSectionCount(2);
      const onInserted = jest.fn().mockResolvedValue(undefined);
      const result = await service.insertItemsAtTop(
        'user-1',
        'sp-1',
        SubprofileSection.Projects,
        {
          expectedEditVersion: 4,
          selectCandidates: () =>
            Promise.resolve([
              { ref: 'entry-new', fields: fields('Newest') },
              { ref: 'entry-old', fields: fields('Older') },
            ]),
          onInserted,
        },
      );

      expect(manager.query).toHaveBeenCalledWith(
        expect.stringContaining('SET "position" = "position" + $1'),
        [2, 'sp-1', SubprofileSection.Projects],
      );
      const [savedRows] = manager.save.mock.calls[0] as [SubprofileItem[]];
      expect(
        savedRows.map((row) => [row.title, row.position, row.isFeatured]),
      ).toEqual([
        ['Newest', 0, false],
        ['Older', 1, false],
      ]);
      expect(onInserted).toHaveBeenCalledWith(manager, [
        { ref: 'entry-new', itemId: 'item-0' },
        { ref: 'entry-old', itemId: 'item-1' },
      ]);
      expect(manager.update).toHaveBeenCalledWith(
        Subprofile,
        { id: 'sp-1' },
        { editVersion: 5 },
      );
      expect(result.inserted).toBe(2);
      expect(result.subprofile.editVersion).toBe(5);
      // Followers hear about it through the ordinary new-items path, with
      // the new titles first.
      expect(updates.notifyFollowersOfNewItems).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'sp-1' }),
        ['Old A', 'Old B'],
        ['Newest', 'Older', 'Old A', 'Old B'],
        SubprofileSection.Projects,
      );
      // Nothing an owner wrote changed, so no revision is recorded: the item
      // insert is the only save.
      expect(manager.save).toHaveBeenCalledTimes(1);
    });

    it('inserts only as many as fit under MAX_ITEMS_PER_SECTION, newest first', async () => {
      stageSectionCount(99);
      const onInserted = jest.fn().mockResolvedValue(undefined);
      const result = await service.insertItemsAtTop(
        'user-1',
        'sp-1',
        SubprofileSection.Projects,
        {
          selectCandidates: () =>
            Promise.resolve([
              { ref: 'a', fields: fields('A') },
              { ref: 'b', fields: fields('B') },
            ]),
          onInserted,
        },
      );
      expect(result.inserted).toBe(1);
      expect(onInserted).toHaveBeenCalledWith(manager, [
        { ref: 'a', itemId: 'item-0' },
      ]);
    });

    it('answers 422 SECTION_FULL when the section has no room', async () => {
      stageSectionCount(100);
      const error: unknown = await service
        .insertItemsAtTop('user-1', 'sp-1', SubprofileSection.Projects, {
          selectCandidates: () =>
            Promise.resolve([{ ref: 'a', fields: fields('A') }]),
          onInserted: jest.fn(),
        })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(UnprocessableEntityException);
      expect((error as UnprocessableEntityException).getResponse()).toEqual(
        expect.objectContaining({ code: 'SECTION_FULL' }),
      );
      expect(manager.query).not.toHaveBeenCalledWith(
        expect.stringContaining('UPDATE "subprofile_items"'),
        expect.anything(),
      );
    });

    it('writes nothing and keeps the edit version when no candidate is left', async () => {
      stageSectionCount(2);
      const result = await service.insertItemsAtTop(
        'user-1',
        'sp-1',
        SubprofileSection.Projects,
        { selectCandidates: () => Promise.resolve([]), onInserted: jest.fn() },
      );
      expect(result.inserted).toBe(0);
      expect(manager.save).not.toHaveBeenCalled();
      expect(
        manager.update.mock.calls.some(
          ([entity]: unknown[]) => entity === Subprofile,
        ),
      ).toBe(false);
      expect(updates.notifyFollowersOfNewItems).not.toHaveBeenCalled();
    });

    it('refuses a stale expectedEditVersion before selecting anything', async () => {
      stageSectionCount(2);
      const selectCandidates = jest.fn().mockResolvedValue([]);
      await expect(
        service.insertItemsAtTop('user-1', 'sp-1', SubprofileSection.Projects, {
          expectedEditVersion: 3,
          selectCandidates,
          onInserted: jest.fn(),
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(selectCandidates).not.toHaveBeenCalled();
    });

    it.each([SubprofileSection.Gallery, SubprofileSection.Links])(
      'refuses to import into %s',
      async (section) => {
        await expect(
          service.insertItemsAtTop('user-1', 'sp-1', section, {
            selectCandidates: jest.fn(),
            onInserted: jest.fn(),
          }),
        ).rejects.toBeInstanceOf(BadRequestException);
      },
    );
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
        await service.replaceSection('user-1', 'sp-1', 'projects', savedItems);

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
        expect(credits.emitSubprofileCreditNotifications).toHaveBeenCalledTimes(
          1,
        );
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
        expect(
          credits.emitSubprofileCreditNotifications,
        ).not.toHaveBeenCalled();
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
        expect(credits.emitSubprofileCreditNotifications).toHaveBeenCalledTimes(
          1,
        );
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

    // Linked personas claim a real `/p/<handle>` in the shared registry, the
    // way unlinked ones do. With no handle the server derives
    // `<creatorSlug>-<personaSlug>` from the CREATOR's profile slug.
    describe('linked personas claim a handle', () => {
      const personaOwner = { kind: 'subprofile', subprofileId: 'sp-1' };
      const linkedDraft = (overrides: Partial<Subprofile> = {}) =>
        makeSubprofile({
          linkVisibility: SubprofileLinkVisibility.Linked,
          status: SubprofileStatus.Draft,
          handle: null,
          avatarUrl: null,
          bio: null,
          ...overrides,
        });
      const rejectionOf = async (promise: Promise<unknown>) => {
        try {
          await promise;
        } catch (err) {
          return err;
        }
        throw new Error('Expected the promise to reject');
      };

      beforeEach(() => {
        items.find.mockResolvedValue([]);
      });

      it('derives <creatorSlug>-<slug> for a draft with no handle and claims it in one transaction', async () => {
        subprofiles.findOne.mockResolvedValue(linkedDraft());

        const dto = await service.publish('user-1', 'sp-1');

        expect(dataSource.manager.findOne).toHaveBeenCalledWith(Profile, {
          where: { userId: 'user-1' },
        });
        expect(dataSource.transaction).toHaveBeenCalledTimes(1);
        expect(handlesService.rename).toHaveBeenCalledWith(
          manager,
          null,
          'robin-nightform',
          personaOwner,
        );
        expect(manager.update).toHaveBeenCalledWith(
          Subprofile,
          { id: 'sp-1' },
          { status: SubprofileStatus.Published, handle: 'robin-nightform' },
        );
        expect(dto.status).toBe(SubprofileStatus.Published);
        expect(dto.handle).toBe('robin-nightform');
      });

      it('uses the creator slug when a co-owner publishes', async () => {
        subprofiles.findOne.mockResolvedValue(
          linkedDraft({ userId: 'creator-1' }),
        );
        dataSource.manager.findOne.mockImplementation((entity: unknown) =>
          Promise.resolve(
            entity === Profile
              ? makeProfile({ userId: 'creator-1', slug: 'sam' })
              : null,
          ),
        );

        const dto = await service.publish('user-1', 'sp-1');

        expect(dataSource.manager.findOne).toHaveBeenCalledWith(Profile, {
          where: { userId: 'creator-1' },
        });
        expect(dto.handle).toBe('sam-nightform');
      });

      it('claims the handle the owner typed', async () => {
        subprofiles.findOne.mockResolvedValue(
          linkedDraft({ handle: 'night-owl' }),
        );

        const dto = await service.publish('user-1', 'sp-1');

        expect(handlesService.isTaken).toHaveBeenCalledWith(
          dataSource.manager,
          'night-owl',
          personaOwner,
        );
        expect(handlesService.rename).toHaveBeenCalledWith(
          manager,
          null,
          'night-owl',
          personaOwner,
        );
        expect(manager.update).toHaveBeenCalledWith(
          Subprofile,
          { id: 'sp-1' },
          { status: SubprofileStatus.Published, handle: 'night-owl' },
        );
        expect(dto.handle).toBe('night-owl');
      });

      it('422s a typed handle that is already taken, before any transaction', async () => {
        subprofiles.findOne.mockResolvedValue(
          linkedDraft({ handle: 'night-owl' }),
        );
        handlesService.isTaken.mockResolvedValue(true);

        const error = await rejectionOf(service.publish('user-1', 'sp-1'));

        expect(error).toBeInstanceOf(UnprocessableEntityException);
        expect(
          (error as UnprocessableEntityException).getResponse(),
        ).toMatchObject({ unmet: ['handle_taken'] });
        expect(dataSource.transaction).not.toHaveBeenCalled();
      });

      it('422s a linked draft with no handle when its creator has no profile', async () => {
        subprofiles.findOne.mockResolvedValue(linkedDraft());
        dataSource.manager.findOne.mockResolvedValue(null);

        const error = await rejectionOf(service.publish('user-1', 'sp-1'));

        expect(error).toBeInstanceOf(UnprocessableEntityException);
        expect(
          (error as UnprocessableEntityException).getResponse(),
        ).toMatchObject({
          code: 'SUBPROFILE_NOT_READY',
          unmet: ['handle_invalid'],
        });
        expect(dataSource.transaction).not.toHaveBeenCalled();
        expect(handlesService.rename).not.toHaveBeenCalled();
      });

      it('retries a derived handle lost to a concurrent claim with the next candidate', async () => {
        subprofiles.findOne.mockResolvedValue(linkedDraft());
        // The concurrent writer commits `robin-nightform` as the first claim
        // fails, so the second derivation reads it as taken.
        const takenNames = new Set<string>();
        handlesService.isTaken.mockImplementation(
          (_entityManager: unknown, name: string) =>
            Promise.resolve(takenNames.has(name)),
        );
        handlesService.rename.mockImplementationOnce(() => {
          takenNames.add('robin-nightform');
          return Promise.reject(
            new ConflictException('That handle is already taken'),
          );
        });

        const dto = await service.publish('user-1', 'sp-1');

        expect(dataSource.transaction).toHaveBeenCalledTimes(2);
        expect(handlesService.rename).toHaveBeenCalledTimes(2);
        expect(handlesService.rename).toHaveBeenLastCalledWith(
          manager,
          null,
          'robin-nightform-2',
          personaOwner,
        );
        expect(dto.handle).toBe('robin-nightform-2');
        expect(eventEmitter.emit).toHaveBeenCalledTimes(1);
      });

      it('gives up on a derived handle after 5 lost races', async () => {
        subprofiles.findOne.mockResolvedValue(linkedDraft());
        handlesService.rename.mockRejectedValue(
          new ConflictException('That handle is already taken'),
        );

        const error = await rejectionOf(service.publish('user-1', 'sp-1'));

        expect(error).toBeInstanceOf(ConflictException);
        expect((error as ConflictException).getResponse()).toMatchObject({
          code: 'handle_derivation_failed',
        });
        expect(handlesService.rename).toHaveBeenCalledTimes(5);
        expect(manager.update).not.toHaveBeenCalled();
        expect(eventEmitter.emit).not.toHaveBeenCalled();
      });

      it('surfaces a typed handle lost to a concurrent claim as 422 handle_taken, with no retry', async () => {
        subprofiles.findOne.mockResolvedValue(
          linkedDraft({ handle: 'night-owl' }),
        );
        handlesService.rename.mockRejectedValue(
          new ConflictException('That handle is already taken'),
        );

        const error = await rejectionOf(service.publish('user-1', 'sp-1'));

        expect(error).toBeInstanceOf(UnprocessableEntityException);
        expect(
          (error as UnprocessableEntityException).getResponse(),
        ).toMatchObject({ unmet: ['handle_taken'] });
        expect(dataSource.transaction).toHaveBeenCalledTimes(1);
        expect(handlesService.rename).toHaveBeenCalledTimes(1);
      });

      it('422s an unlinked handle that carries the creator slug', async () => {
        subprofiles.findOne.mockResolvedValue(
          completeUnlinked({ handle: 'robin-after-dark' }),
        );

        const error = await rejectionOf(service.publish('user-1', 'sp-1'));

        expect(error).toBeInstanceOf(UnprocessableEntityException);
        expect(
          (error as UnprocessableEntityException).getResponse(),
        ).toMatchObject({ unmet: ['handle_names_owner'] });
        expect(dataSource.transaction).not.toHaveBeenCalled();
      });
    });
  });

  describe('unpublish', () => {
    // A linked draft keeps its `/p/` address for the owner's preview, so the
    // registry claim is released but the handle stays on the row.
    it('releases the registry claim of a published linked persona and keeps its handle on the draft, in one transaction', async () => {
      subprofiles.findOne.mockResolvedValue(
        makeSubprofile({
          linkVisibility: SubprofileLinkVisibility.Linked,
          status: SubprofileStatus.Published,
          handle: 'robin-nightform',
        }),
      );

      const dto = await service.unpublish('user-1', 'sp-1');

      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(handlesService.release).toHaveBeenCalledWith(
        manager,
        'robin-nightform',
        { kind: 'subprofile', subprofileId: 'sp-1' },
      );
      expect(manager.update).toHaveBeenCalledWith(
        Subprofile,
        { id: 'sp-1' },
        { status: SubprofileStatus.Draft, handle: 'robin-nightform' },
      );
      expect(dto.status).toBe(SubprofileStatus.Draft);
      expect(dto.handle).toBe('robin-nightform');
    });

    it('releases the handle of a published unlinked persona and nulls it in one transaction', async () => {
      subprofiles.findOne.mockResolvedValue(
        completeUnlinked({ status: SubprofileStatus.Published }),
      );

      const dto = await service.unpublish('user-1', 'sp-1');

      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(handlesService.release).toHaveBeenCalledWith(
        manager,
        'nightform',
        { kind: 'subprofile', subprofileId: 'sp-1' },
      );
      expect(manager.update).toHaveBeenCalledWith(
        Subprofile,
        { id: 'sp-1' },
        { status: SubprofileStatus.Draft, handle: null },
      );
      expect(dto.status).toBe(SubprofileStatus.Draft);
      expect(dto.handle).toBeNull();
    });

    it('refuses with a 409 when the persona was unlinked after the load, and releases nothing', async () => {
      subprofiles.findOne.mockResolvedValue(
        makeSubprofile({
          linkVisibility: SubprofileLinkVisibility.Linked,
          status: SubprofileStatus.Published,
          handle: 'robin-nightform',
        }),
      );
      manager.findOne.mockResolvedValue(
        makeSubprofile({
          linkVisibility: SubprofileLinkVisibility.Unlinked,
          status: SubprofileStatus.Published,
          handle: 'robin-nightform',
        }),
      );

      await expect(service.unpublish('user-1', 'sp-1')).rejects.toBeInstanceOf(
        ConflictException,
      );

      expect(handlesService.release).not.toHaveBeenCalled();
      expect(manager.update).not.toHaveBeenCalled();
    });

    it('refuses with a 409 when the handle changed after the load, and releases nothing', async () => {
      subprofiles.findOne.mockResolvedValue(
        makeSubprofile({
          linkVisibility: SubprofileLinkVisibility.Linked,
          status: SubprofileStatus.Published,
          handle: 'robin-nightform',
        }),
      );
      manager.findOne.mockResolvedValue(
        makeSubprofile({
          linkVisibility: SubprofileLinkVisibility.Linked,
          status: SubprofileStatus.Published,
          handle: 'night-owl',
        }),
      );

      await expect(service.unpublish('user-1', 'sp-1')).rejects.toBeInstanceOf(
        ConflictException,
      );

      expect(handlesService.release).not.toHaveBeenCalled();
      expect(manager.update).not.toHaveBeenCalled();
    });
  });

  // The creator role can move to another co-owner (`transferCreatorWithin`)
  // between `getOwned`'s unlocked read and the save. Every whole-entity save
  // re-reads the row under the lock the transfer holds, so a stale copy never
  // writes the old creator or slug back.
  describe('saves racing a creator transfer', () => {
    // What `getOwned` read, before the transfer.
    const loadedBeforeTransfer = (overrides: Partial<Subprofile> = {}) =>
      makeSubprofile({ userId: 'user-1', slug: 'nightform', ...overrides });
    // What the transfer committed: a new creator and a suffixed slug.
    const committedAfterTransfer = (overrides: Partial<Subprofile> = {}) =>
      makeSubprofile({
        userId: 'successor-1',
        slug: 'nightform-2',
        ...overrides,
      });
    const savedSubprofile = () =>
      (manager.save.mock.calls[0] as [Subprofile])[0];

    it('an edit loaded before the transfer keeps the new creator and slug', async () => {
      subprofiles.findOne.mockResolvedValue(loadedBeforeTransfer());
      manager.findOne.mockResolvedValue(committedAfterTransfer());

      await service.update('user-1', 'sp-1', { bio: 'Fresh bio' });

      expect(manager.findOne).toHaveBeenCalledWith(Subprofile, {
        where: { id: 'sp-1' },
        lock: { mode: 'pessimistic_write' },
      });
      expect(savedSubprofile()).toMatchObject({
        userId: 'successor-1',
        slug: 'nightform-2',
        bio: 'Fresh bio',
      });
      expect(subprofiles.save).not.toHaveBeenCalled();
    });

    it('an edit that sets a new slug keeps it, with the committed creator', async () => {
      subprofiles.findOne.mockResolvedValue(loadedBeforeTransfer());
      manager.findOne.mockResolvedValue(committedAfterTransfer());

      await service.update('user-1', 'sp-1', { slug: 'renamed' });

      expect(savedSubprofile()).toMatchObject({
        userId: 'successor-1',
        slug: 'renamed',
      });
    });

    it('an edit that resends the loaded slug unchanged keeps the committed slug', async () => {
      subprofiles.findOne.mockResolvedValue(loadedBeforeTransfer());
      manager.findOne.mockResolvedValue(committedAfterTransfer());

      await service.update('user-1', 'sp-1', { slug: 'nightform' });

      expect(savedSubprofile().slug).toBe('nightform-2');
    });

    it('keeps a moderator removal committed between load and save', async () => {
      const removedAt = new Date('2026-09-01T12:00:00Z');
      subprofiles.findOne.mockResolvedValue(
        loadedBeforeTransfer({ removedAt: null }),
      );
      manager.findOne.mockResolvedValue(loadedBeforeTransfer({ removedAt }));

      await service.update('user-1', 'sp-1', { bio: 'Fresh bio' });

      expect(savedSubprofile()).toMatchObject({
        removedAt,
        bio: 'Fresh bio',
      });
    });

    // PRD-431 x the edit save: the transfer re-issues a creator-named handle
    // under the persona lock without moving the link or the edit version,
    // so an edit that waited on it must keep the re-issued name.
    it('an edit loaded before the transfer keeps the handle the transfer re-issued', async () => {
      const publishedLinked = {
        linkVisibility: SubprofileLinkVisibility.Linked,
        status: SubprofileStatus.Published,
      };
      subprofiles.findOne.mockResolvedValue(
        loadedBeforeTransfer({ ...publishedLinked, handle: 'robin-nightform' }),
      );
      manager.findOne.mockResolvedValue(
        committedAfterTransfer({ ...publishedLinked, handle: 'sam-nightform' }),
      );

      const saved = await service.update('user-1', 'sp-1', {
        bio: 'Fresh bio',
      });

      expect(savedSubprofile()).toMatchObject({
        handle: 'sam-nightform',
        bio: 'Fresh bio',
      });
      expect(saved.handle).toBe('sam-nightform');
      expect(handlesService.rename).not.toHaveBeenCalled();
      expect(handlesService.release).not.toHaveBeenCalled();
    });

    it('an edit of a linked draft loaded before the transfer keeps its re-issued draft handle', async () => {
      const linkedDraft = {
        linkVisibility: SubprofileLinkVisibility.Linked,
        status: SubprofileStatus.Draft,
      };
      subprofiles.findOne.mockResolvedValue(
        loadedBeforeTransfer({ ...linkedDraft, handle: 'robin-nightform' }),
      );
      manager.findOne.mockResolvedValue(
        committedAfterTransfer({ ...linkedDraft, handle: 'sam-nightform' }),
      );

      await service.update('user-1', 'sp-1', { tagline: 'Fresh tagline' });

      expect(savedSubprofile().handle).toBe('sam-nightform');
    });

    // A link switch frees the name the LOCKED row holds. Releasing the
    // loaded one after a rename or re-issue committed meanwhile would leave
    // the committed name claimed by a row that no longer stores it.
    describe('a link switch that waited on the lock', () => {
      const personaOwner = { kind: 'subprofile', subprofileId: 'sp-1' };
      const publishedLinked = {
        linkVisibility: SubprofileLinkVisibility.Linked,
        status: SubprofileStatus.Published,
      };

      it('releases the name a rename committed meanwhile and leaves nothing claimed', async () => {
        subprofiles.findOne.mockResolvedValue(
          loadedBeforeTransfer({
            ...publishedLinked,
            handle: 'robin-nightform',
          }),
        );
        // The same creator renamed it from another tab while this unlink
        // waited on the persona lock.
        manager.findOne.mockResolvedValue(
          loadedBeforeTransfer({ ...publishedLinked, handle: 'robin-sings' }),
        );

        await service.update('user-1', 'sp-1', {
          linkVisibility: SubprofileLinkVisibility.Unlinked,
        });

        expect(handlesService.release).toHaveBeenCalledTimes(1);
        expect(handlesService.release).toHaveBeenCalledWith(
          manager,
          'robin-sings',
          personaOwner,
          { isForwarding: false },
        );
        expect(handlesService.rename).not.toHaveBeenCalled();
        expect(savedSubprofile()).toMatchObject({
          linkVisibility: SubprofileLinkVisibility.Unlinked,
          status: SubprofileStatus.Draft,
          handle: null,
        });
      });

      // A transfer moves the creator role, and a switch that releases a name
      // is creator-only, so the departed creator's switch is refused under
      // the lock before it can release either name.
      it('refuses the switch of a creator who left meanwhile before any registry work', async () => {
        subprofiles.findOne.mockResolvedValue(
          loadedBeforeTransfer({
            ...publishedLinked,
            handle: 'robin-nightform',
          }),
        );
        manager.findOne.mockResolvedValue(
          committedAfterTransfer({
            ...publishedLinked,
            handle: 'sam-nightform',
          }),
        );

        await expect(
          service.update('user-1', 'sp-1', {
            linkVisibility: SubprofileLinkVisibility.Unlinked,
          }),
        ).rejects.toBeInstanceOf(ForbiddenException);

        expect(handlesService.release).not.toHaveBeenCalled();
        expect(handlesService.rename).not.toHaveBeenCalled();
        expect(handlesService.stopForwardingFor).not.toHaveBeenCalled();
        expect(manager.save).not.toHaveBeenCalled();
      });

      it('refuses a switch over a row published meanwhile before any registry work', async () => {
        subprofiles.findOne.mockResolvedValue(
          loadedBeforeTransfer({
            linkVisibility: SubprofileLinkVisibility.Linked,
            status: SubprofileStatus.Draft,
            handle: 'robin-nightform',
          }),
        );
        manager.findOne.mockResolvedValue(
          loadedBeforeTransfer({
            ...publishedLinked,
            handle: 'robin-nightform',
            editVersion: 3,
          }),
        );

        const error: unknown = await service
          .update('user-1', 'sp-1', {
            linkVisibility: SubprofileLinkVisibility.Unlinked,
          })
          .then(
            () => undefined,
            (rejection: unknown) => rejection,
          );

        expect(error).toBeInstanceOf(ConflictException);
        expect((error as ConflictException).getResponse()).toMatchObject({
          code: 'PERSONA_EDIT_CONFLICT',
          currentEditVersion: 3,
        });
        expect(handlesService.release).not.toHaveBeenCalled();
        expect(handlesService.stopForwardingFor).not.toHaveBeenCalled();
        expect(manager.delete).not.toHaveBeenCalled();
        expect(manager.save).not.toHaveBeenCalled();
      });
    });

    // Lock order: every transaction takes the persona row, then the handle
    // row, so a handle change and an unpublish can never deadlock.
    const lockedPersonaReadOrder = () => {
      const lockCallIndex = manager.findOne.mock.calls.findIndex(
        ([entity]) => entity === Subprofile,
      );
      return manager.findOne.mock.invocationCallOrder[lockCallIndex] ?? 0;
    };

    it('locks the persona row before moving the registry claim on a handle change', async () => {
      subprofiles.findOne.mockResolvedValue(
        completeUnlinked({ status: SubprofileStatus.Published }),
      );

      await service.update('user-1', 'sp-1', { handle: 'nightform-renamed' });

      expect(handlesService.rename).toHaveBeenCalledTimes(1);
      const renameOrder = handlesService.rename.mock.invocationCallOrder[0];
      expect(lockedPersonaReadOrder()).toBeLessThan(renameOrder ?? 0);
      expect(manager.save).toHaveBeenCalledTimes(1);
    });

    it('refuses a former creator handle change before releasing anything', async () => {
      subprofiles.findOne.mockResolvedValue(
        completeUnlinked({ status: SubprofileStatus.Published }),
      );
      manager.findOne.mockResolvedValue(committedAfterTransfer());

      await expect(
        service.update('user-1', 'sp-1', { handle: 'nightform-renamed' }),
      ).rejects.toBeInstanceOf(ForbiddenException);

      expect(handlesService.release).not.toHaveBeenCalled();
      expect(handlesService.rename).not.toHaveBeenCalled();
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('locks the persona row before claiming the handle on an unlinked publish', async () => {
      subprofiles.findOne.mockResolvedValue(completeUnlinked());
      items.find.mockResolvedValue(contentItems(MIN_CONTENT_ITEMS));

      await service.publish('user-1', 'sp-1');

      expect(handlesService.rename).toHaveBeenCalledTimes(1);
      const renameOrder = handlesService.rename.mock.invocationCallOrder[0];
      expect(lockedPersonaReadOrder()).toBeLessThan(renameOrder ?? 0);
    });

    it('refuses a stale edit by a member who left meanwhile', async () => {
      subprofiles.findOne.mockResolvedValue(
        loadedBeforeTransfer({ userId: 'creator-9' }),
      );
      // No roster row for the editor on the locked read.
      manager.count.mockResolvedValue(0);

      await expect(
        service.update('user-1', 'sp-1', { bio: 'Fresh bio' }),
      ).rejects.toThrow(new ForbiddenException('Not your subprofile'));

      expect(manager.count).toHaveBeenCalledWith(SubprofileMember, {
        where: { subprofileId: 'sp-1', userId: 'user-1' },
      });
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('refuses a stale edit by a creator who handed the persona over', async () => {
      subprofiles.findOne.mockResolvedValue(loadedBeforeTransfer());
      manager.findOne.mockResolvedValue(committedAfterTransfer());
      manager.count.mockResolvedValue(0);

      await expect(
        service.update('user-1', 'sp-1', { bio: 'Fresh bio' }),
      ).rejects.toThrow(new ForbiddenException('Not your subprofile'));

      expect(manager.save).not.toHaveBeenCalled();
    });

    it('refuses a creator-only edit once the creator role has moved', async () => {
      subprofiles.findOne.mockResolvedValue(
        loadedBeforeTransfer({ visibility: SubprofileVisibility.Open }),
      );
      manager.findOne.mockResolvedValue(committedAfterTransfer());

      await expect(
        service.update('user-1', 'sp-1', {
          visibility: SubprofileVisibility.Private,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);

      expect(manager.save).not.toHaveBeenCalled();
    });

    it('a linked publish loaded before the transfer derives from the new creator and writes only status and handle', async () => {
      subprofiles.findOne.mockResolvedValue(
        loadedBeforeTransfer({
          linkVisibility: SubprofileLinkVisibility.Linked,
          status: SubprofileStatus.Draft,
        }),
      );
      manager.findOne.mockImplementation((entity: unknown) =>
        Promise.resolve(
          entity === Profile
            ? makeProfile({ userId: 'successor-1', slug: 'sam' })
            : committedAfterTransfer({
                linkVisibility: SubprofileLinkVisibility.Linked,
              }),
        ),
      );
      items.find.mockResolvedValue([]);

      await service.publish('user-1', 'sp-1');

      // The locked row names the successor, so the handle is built from
      // their profile slug and the committed persona slug.
      expect(manager.findOne).toHaveBeenCalledWith(Profile, {
        where: { userId: 'successor-1' },
      });
      // Only these two columns are written, so the stale creator and slug
      // loaded before the transfer are never written back.
      expect(manager.update).toHaveBeenCalledWith(
        Subprofile,
        { id: 'sp-1' },
        { status: SubprofileStatus.Published, handle: 'sam-nightform-2' },
      );
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('refuses an unpublish by the former creator of a linked persona', async () => {
      subprofiles.findOne.mockResolvedValue(
        loadedBeforeTransfer({
          linkVisibility: SubprofileLinkVisibility.Linked,
          status: SubprofileStatus.Published,
        }),
      );
      manager.findOne.mockResolvedValue(committedAfterTransfer());

      await expect(service.unpublish('user-1', 'sp-1')).rejects.toBeInstanceOf(
        ForbiddenException,
      );

      expect(manager.save).not.toHaveBeenCalled();
    });

    it('refuses an unpublish by the former creator of an unlinked persona', async () => {
      subprofiles.findOne.mockResolvedValue(
        loadedBeforeTransfer({
          linkVisibility: SubprofileLinkVisibility.Unlinked,
          status: SubprofileStatus.Published,
          handle: 'nightform',
        }),
      );
      manager.findOne.mockResolvedValue(committedAfterTransfer());

      await expect(service.unpublish('user-1', 'sp-1')).rejects.toBeInstanceOf(
        ForbiddenException,
      );

      expect(manager.update).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    const rosterWith = (...memberUserIds: string[]) => {
      manager.find.mockImplementation((entity: unknown) =>
        Promise.resolve(
          entity === SubprofileMember
            ? memberUserIds.map((memberUserId) => ({ userId: memberUserId }))
            : [],
        ),
      );
    };

    it('deletes the locked row in one transaction and tells the co-owners after it', async () => {
      subprofiles.findOne.mockResolvedValue(makeSubprofile());
      rosterWith('user-1', 'co-owner-1');

      await service.remove('user-1', 'sp-1');

      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(manager.findOne).toHaveBeenCalledWith(Subprofile, {
        where: { id: 'sp-1' },
        lock: { mode: 'pessimistic_write' },
      });
      expect(manager.find).toHaveBeenCalledWith(SubprofileMember, {
        where: { subprofileId: 'sp-1' },
        select: { userId: true },
      });
      expect(manager.remove).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'sp-1', userId: 'user-1' }),
      );
      expect(subprofiles.remove).not.toHaveBeenCalled();
      const lockOrder = manager.findOne.mock.invocationCallOrder[0] ?? 0;
      const removeOrder = manager.remove.mock.invocationCallOrder[0] ?? 0;
      const emitOrder = eventEmitter.emit.mock.invocationCallOrder[0] ?? 0;
      expect(lockOrder).toBeLessThan(removeOrder);
      expect(removeOrder).toBeLessThan(emitOrder);
      expect(eventEmitter.emit).toHaveBeenCalledWith(SUBPROFILE_DELETED, {
        subprofileId: 'sp-1',
        displayName: 'Nightform',
        deletedByUserId: 'user-1',
        coOwnerIds: ['co-owner-1'],
      });
    });

    // ENG-449: the name stays reserved for the cooldown, and the reservation
    // outlives the row (`handle_history`'s persona FK is ON DELETE SET NULL).
    it('releases the registry handle without forwarding before the row goes', async () => {
      subprofiles.findOne.mockResolvedValue(
        completeUnlinked({ status: SubprofileStatus.Published }),
      );
      manager.find.mockImplementation((entity: unknown) =>
        Promise.resolve(
          entity === Handle
            ? [{ name: 'nightform' }]
            : entity === SubprofileMember
              ? [{ userId: 'user-1' }]
              : [],
        ),
      );

      await service.remove('user-1', 'sp-1');

      expect(manager.find).toHaveBeenCalledWith(Handle, {
        where: { ownerKind: HandleOwnerKind.Subprofile, subprofileId: 'sp-1' },
        select: { name: true },
      });
      expect(handlesService.release).toHaveBeenCalledTimes(1);
      expect(handlesService.release).toHaveBeenCalledWith(
        manager,
        'nightform',
        { kind: 'subprofile', subprofileId: 'sp-1' },
        { isForwarding: false },
      );
      const releaseOrder =
        handlesService.release.mock.invocationCallOrder[0] ?? 0;
      const removeOrder = manager.remove.mock.invocationCallOrder[0] ?? 0;
      expect(releaseOrder).toBeLessThan(removeOrder);
    });

    it('releases nothing for a draft that holds no registry handle', async () => {
      subprofiles.findOne.mockResolvedValue(makeSubprofile());
      rosterWith('user-1');

      await service.remove('user-1', 'sp-1');

      expect(handlesService.release).not.toHaveBeenCalled();
      expect(manager.remove).toHaveBeenCalledTimes(1);
    });

    it('releases nothing when the delete is refused', async () => {
      subprofiles.findOne.mockResolvedValue(
        completeUnlinked({ status: SubprofileStatus.Published }),
      );
      manager.findOne.mockResolvedValue(
        completeUnlinked({
          userId: 'successor-1',
          status: SubprofileStatus.Published,
        }),
      );

      await expect(service.remove('user-1', 'sp-1')).rejects.toBeInstanceOf(
        ForbiddenException,
      );

      expect(handlesService.release).not.toHaveBeenCalled();
    });

    it('emits nothing when the creator was the only member', async () => {
      subprofiles.findOne.mockResolvedValue(makeSubprofile());
      rosterWith('user-1');

      await service.remove('user-1', 'sp-1');

      expect(manager.remove).toHaveBeenCalledTimes(1);
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    // The race the lock closes: the gate read still names the caller as
    // creator, but a concurrent leave committed a handoff before the lock
    // was taken, so the persona now belongs to the successor.
    it('refuses a stale delete by a creator who handed the persona over', async () => {
      subprofiles.findOne.mockResolvedValue(makeSubprofile());
      manager.findOne.mockResolvedValue(
        makeSubprofile({ userId: 'successor-1', slug: 'nightform-2' }),
      );
      rosterWith('successor-1', 'co-owner-1');

      await expect(service.remove('user-1', 'sp-1')).rejects.toBeInstanceOf(
        ForbiddenException,
      );

      expect(manager.remove).not.toHaveBeenCalled();
      expect(subprofiles.remove).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('refuses a stale delete once the caller has left the roster', async () => {
      subprofiles.findOne.mockResolvedValue(makeSubprofile());
      manager.findOne.mockResolvedValue(
        makeSubprofile({ userId: 'successor-1', slug: 'nightform-2' }),
      );
      manager.count.mockResolvedValue(0);

      await expect(service.remove('user-1', 'sp-1')).rejects.toThrow(
        new ForbiddenException('Not your subprofile'),
      );

      expect(manager.remove).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('keeps the unlocked creator gate for a co-owner who never created it', async () => {
      subprofiles.findOne.mockResolvedValue(
        makeSubprofile({ userId: 'creator-9' }),
      );

      await expect(service.remove('user-1', 'sp-1')).rejects.toThrow(
        new ForbiddenException('Only the persona creator can delete it'),
      );

      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(manager.remove).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    // The transaction manager stages no creator profile here, so the linked
    // draft has no name to derive and keeps a null handle.
    it('drops the unlinked handle when switching to linked, and leaves it null when the creator has no profile', async () => {
      const sp = completeUnlinked({
        linkVisibility: SubprofileLinkVisibility.Unlinked,
      });
      subprofiles.findOne.mockResolvedValue(sp);
      await service.update('user-1', 'sp-1', {
        linkVisibility: SubprofileLinkVisibility.Linked,
      });
      const saved = (manager.save.mock.calls[0] as [Subprofile])[0];
      expect(saved.handle).toBeNull();
      expect(manager.findOne).toHaveBeenCalledWith(Profile, {
        where: { userId: 'user-1' },
      });
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
      const saved = (manager.save.mock.calls[0] as [Subprofile])[0];
      expect(saved.status).toBe(SubprofileStatus.Draft);
    });

    // PRD-435: the therapist cards read this stamp to tell a fresh status
    // from a stale one, so it moves with the availability or the therapist
    // status and with nothing else.
    describe('availability stamp', () => {
      const earlierStamp = new Date('2026-03-01T09:00:00Z');
      const therapistSkin = (status: string) =>
        ({ therapist: { status } }) as unknown as SkinData;
      const therapistPersona = () =>
        makeSubprofile({
          kind: SubprofileKind.Therapist,
          availability: 'open_to_collabs',
          skinData: therapistSkin('open'),
          availabilityUpdatedAt: earlierStamp,
        });
      const savedRow = () => (manager.save.mock.calls[0] as [Subprofile])[0];

      it('stamps the save time when the availability changes', async () => {
        subprofiles.findOne.mockResolvedValue(therapistPersona());
        const before = Date.now();
        await service.update('user-1', 'sp-1', {
          availability: 'booking',
          skinData: therapistSkin('wait'),
        });
        const stamp = savedRow().availabilityUpdatedAt;
        expect(stamp).toBeInstanceOf(Date);
        expect(stamp!.getTime()).toBeGreaterThanOrEqual(before);
      });

      it('stamps the save time when only the therapist status changes', async () => {
        subprofiles.findOne.mockResolvedValue(therapistPersona());
        await service.update('user-1', 'sp-1', {
          skinData: therapistSkin('closed'),
        });
        expect(savedRow().availabilityUpdatedAt).not.toEqual(earlierStamp);
        expect(savedRow().availabilityUpdatedAt).toBeInstanceOf(Date);
      });

      it('keeps the stamp when an edit leaves the status alone', async () => {
        subprofiles.findOne.mockResolvedValue(therapistPersona());
        await service.update('user-1', 'sp-1', {
          bio: 'A new bio',
          skinData: therapistSkin('open'),
        });
        expect(savedRow().availabilityUpdatedAt).toEqual(earlierStamp);
      });

      it('stamps the save time when the owner confirms an unchanged status', async () => {
        subprofiles.findOne.mockResolvedValue(therapistPersona());
        const before = Date.now();
        await service.update('user-1', 'sp-1', {
          availability: 'open_to_collabs',
          skinData: therapistSkin('open'),
          confirmAvailability: true,
        });
        const stamp = savedRow().availabilityUpdatedAt;
        expect(stamp).toBeInstanceOf(Date);
        expect(stamp!.getTime()).toBeGreaterThanOrEqual(before);
        expect(savedRow()).not.toHaveProperty('confirmAvailability');
      });

      it('keeps the stamp when an editor save resends an unchanged availability', async () => {
        subprofiles.findOne.mockResolvedValue(therapistPersona());
        await service.update('user-1', 'sp-1', {
          bio: 'Another bio',
          availability: 'open_to_collabs',
        });
        expect(savedRow().availabilityUpdatedAt).toEqual(earlierStamp);
      });

      it('keeps the committed stamp when the loaded copy is stale', async () => {
        subprofiles.findOne.mockResolvedValue(therapistPersona());
        const committedStamp = new Date('2026-09-30T08:00:00Z');
        manager.findOne.mockImplementation((entity: unknown) =>
          Promise.resolve(
            entity === Subprofile
              ? {
                  ...therapistPersona(),
                  availabilityUpdatedAt: committedStamp,
                }
              : null,
          ),
        );
        await service.update('user-1', 'sp-1', { tagline: 'Still here' });
        expect(savedRow().availabilityUpdatedAt).toEqual(committedStamp);
      });
    });

    // A link switch frees the old name WITHOUT forwarding, in either
    // direction: forwarding would tie a pseudonymous address to the member
    // behind it. A plain handle edit keeps forwarding, for both link kinds.
    describe('link switches and handle edits', () => {
      const personaOwner = { kind: 'subprofile', subprofileId: 'sp-1' };
      const savedSubprofile = () =>
        (manager.save.mock.calls[0] as [Subprofile])[0];
      // The locked re-read returns the row as loaded; a `Profile` read in
      // the transaction returns the creator's profile.
      const stageCreatorProfileInTransaction = (slug: string) => {
        manager.findOne.mockImplementation(
          (entity: unknown, options?: { where?: { userId?: string } }) =>
            Promise.resolve(
              entity === Profile
                ? makeProfile({ userId: options?.where?.userId, slug })
                : entity === Subprofile && committedRowAtLoad
                  ? { ...committedRowAtLoad }
                  : null,
            ),
        );
      };

      it('linked to unlinked with no new handle releases the old one without forwarding and nulls it', async () => {
        subprofiles.findOne.mockResolvedValue(
          makeSubprofile({
            linkVisibility: SubprofileLinkVisibility.Linked,
            status: SubprofileStatus.Published,
            handle: 'robin-nightform',
          }),
        );

        await service.update('user-1', 'sp-1', {
          linkVisibility: SubprofileLinkVisibility.Unlinked,
        });

        expect(handlesService.release).toHaveBeenCalledTimes(1);
        expect(handlesService.release).toHaveBeenCalledWith(
          manager,
          'robin-nightform',
          personaOwner,
          { isForwarding: false },
        );
        expect(savedSubprofile()).toMatchObject({
          linkVisibility: SubprofileLinkVisibility.Unlinked,
          status: SubprofileStatus.Draft,
          handle: null,
        });
        expect(handlesService.rename).not.toHaveBeenCalled();
      });

      it('linked to unlinked with a newly typed handle keeps the typed handle and releases the old one without forwarding', async () => {
        subprofiles.findOne.mockResolvedValue(
          makeSubprofile({
            linkVisibility: SubprofileLinkVisibility.Linked,
            status: SubprofileStatus.Published,
            handle: 'robin-nightform',
          }),
        );

        await service.update('user-1', 'sp-1', {
          linkVisibility: SubprofileLinkVisibility.Unlinked,
          handle: 'night-owl',
        });

        expect(handlesService.release).toHaveBeenCalledTimes(1);
        expect(handlesService.release).toHaveBeenCalledWith(
          manager,
          'robin-nightform',
          personaOwner,
          { isForwarding: false },
        );
        expect(savedSubprofile()).toMatchObject({
          linkVisibility: SubprofileLinkVisibility.Unlinked,
          status: SubprofileStatus.Draft,
          handle: 'night-owl',
        });
        // The typed handle waits for the next publish, which checks it.
        expect(handlesService.rename).not.toHaveBeenCalled();
      });

      it('unlinked to linked on a published persona releases the old handle without forwarding and claims a derived one in the same transaction', async () => {
        subprofiles.findOne.mockResolvedValue(
          completeUnlinked({
            status: SubprofileStatus.Published,
            handle: 'after-dark',
          }),
        );
        stageCreatorProfileInTransaction('robin');

        await service.update('user-1', 'sp-1', {
          linkVisibility: SubprofileLinkVisibility.Linked,
        });

        expect(dataSource.transaction).toHaveBeenCalledTimes(1);
        expect(handlesService.release).toHaveBeenCalledWith(
          manager,
          'after-dark',
          personaOwner,
          { isForwarding: false },
        );
        expect(handlesService.rename).toHaveBeenCalledWith(
          manager,
          null,
          'robin-nightform',
          personaOwner,
        );
        const releaseOrder =
          handlesService.release.mock.invocationCallOrder[0] ?? 0;
        const renameOrder =
          handlesService.rename.mock.invocationCallOrder[0] ?? 0;
        const saveOrder = manager.save.mock.invocationCallOrder[0] ?? 0;
        expect(releaseOrder).toBeLessThan(renameOrder);
        expect(renameOrder).toBeLessThan(saveOrder);
        expect(savedSubprofile()).toMatchObject({
          linkVisibility: SubprofileLinkVisibility.Linked,
          status: SubprofileStatus.Published,
          handle: 'robin-nightform',
        });
      });

      it('unlinked to linked on a published persona claims a handle typed in the same edit', async () => {
        subprofiles.findOne.mockResolvedValue(
          completeUnlinked({
            status: SubprofileStatus.Published,
            handle: 'after-dark',
          }),
        );
        stageCreatorProfileInTransaction('robin');

        await service.update('user-1', 'sp-1', {
          linkVisibility: SubprofileLinkVisibility.Linked,
          handle: 'night-owl',
        });

        expect(handlesService.isTaken).toHaveBeenCalledWith(
          manager,
          'night-owl',
          personaOwner,
        );
        expect(handlesService.rename).toHaveBeenCalledWith(
          manager,
          null,
          'night-owl',
          personaOwner,
        );
        expect(savedSubprofile()).toMatchObject({
          status: SubprofileStatus.Published,
          handle: 'night-owl',
        });
      });

      it('unlinked to linked refuses a typed handle that is taken, and saves nothing', async () => {
        subprofiles.findOne.mockResolvedValue(
          completeUnlinked({
            status: SubprofileStatus.Published,
            handle: 'after-dark',
          }),
        );
        stageCreatorProfileInTransaction('robin');
        handlesService.isTaken.mockResolvedValue(true);

        await expect(
          service.update('user-1', 'sp-1', {
            linkVisibility: SubprofileLinkVisibility.Linked,
            handle: 'night-owl',
          }),
        ).rejects.toBeInstanceOf(UnprocessableEntityException);

        expect(handlesService.rename).not.toHaveBeenCalled();
        expect(manager.save).not.toHaveBeenCalled();
      });

      it('unlinked to linked on a draft claims nothing and stores the derived handle', async () => {
        subprofiles.findOne.mockResolvedValue(
          completeUnlinked({
            status: SubprofileStatus.Draft,
            handle: 'after-dark',
          }),
        );
        stageCreatorProfileInTransaction('robin');

        await service.update('user-1', 'sp-1', {
          linkVisibility: SubprofileLinkVisibility.Linked,
        });

        expect(handlesService.release).not.toHaveBeenCalled();
        expect(handlesService.rename).not.toHaveBeenCalled();
        expect(savedSubprofile()).toMatchObject({
          linkVisibility: SubprofileLinkVisibility.Linked,
          status: SubprofileStatus.Draft,
          handle: 'robin-nightform',
        });
      });

      // A linked draft stores its `/p/<handle>` so the owner can preview it
      // before publish. The name sits on the row with no registry claim.
      describe('a linked draft stores its derived handle', () => {
        const linkedDraft = (overrides: Partial<Subprofile> = {}) =>
          makeSubprofile({
            linkVisibility: SubprofileLinkVisibility.Linked,
            status: SubprofileStatus.Draft,
            handle: null,
            ...overrides,
          });

        it('derives and stores the handle of a linked draft saved with none, and claims nothing', async () => {
          subprofiles.findOne.mockResolvedValue(linkedDraft());
          stageCreatorProfileInTransaction('robin');

          await service.update('user-1', 'sp-1', { bio: 'Fresh bio' });

          expect(dataSource.transaction).toHaveBeenCalledTimes(1);
          expect(manager.findOne).toHaveBeenCalledWith(Profile, {
            where: { userId: 'user-1' },
          });
          expect(handlesService.isTaken).toHaveBeenCalledWith(
            manager,
            'robin-nightform',
            personaOwner,
          );
          expect(manager.exists).toHaveBeenCalledWith(Subprofile, {
            where: { handle: 'robin-nightform', id: Not('sp-1') },
          });
          expect(handlesService.rename).not.toHaveBeenCalled();
          expect(handlesService.release).not.toHaveBeenCalled();
          expect(savedSubprofile()).toMatchObject({
            status: SubprofileStatus.Draft,
            handle: 'robin-nightform',
            bio: 'Fresh bio',
          });
        });

        it('derives from the slug this edit sets', async () => {
          subprofiles.findOne.mockResolvedValue(linkedDraft());
          stageCreatorProfileInTransaction('robin');

          await service.update('user-1', 'sp-1', { slug: 'night-owl' });

          expect(savedSubprofile()).toMatchObject({
            slug: 'night-owl',
            handle: 'robin-night-owl',
          });
        });

        it('skips a derived name another subprofile row already stores', async () => {
          subprofiles.findOne.mockResolvedValue(linkedDraft());
          stageCreatorProfileInTransaction('robin');
          manager.exists.mockImplementation(
            (_entity: unknown, options: { where: { handle: string } }) =>
              Promise.resolve(options.where.handle === 'robin-nightform'),
          );

          await service.update('user-1', 'sp-1', { bio: 'Fresh bio' });

          expect(savedSubprofile().handle).toBe('robin-nightform-2');
          expect(handlesService.rename).not.toHaveBeenCalled();
        });

        it('derives the handle again when the creator clears it', async () => {
          subprofiles.findOne.mockResolvedValue(
            linkedDraft({ handle: 'night-owl' }),
          );
          stageCreatorProfileInTransaction('robin');

          await service.update('user-1', 'sp-1', { handle: '' });

          expect(savedSubprofile()).toMatchObject({
            status: SubprofileStatus.Draft,
            handle: 'robin-nightform',
          });
          expect(handlesService.release).not.toHaveBeenCalled();
          expect(handlesService.rename).not.toHaveBeenCalled();
        });

        it('lets a co-owner save an unrelated field on a linked draft with no handle, and derives from the creator', async () => {
          subprofiles.findOne.mockResolvedValue(
            linkedDraft({ userId: 'creator-1' }),
          );
          stageCreatorProfileInTransaction('sam');

          await service.update('user-1', 'sp-1', { bio: 'Fresh bio' });

          expect(manager.findOne).toHaveBeenCalledWith(Profile, {
            where: { userId: 'creator-1' },
          });
          expect(savedSubprofile()).toMatchObject({
            userId: 'creator-1',
            handle: 'sam-nightform',
            bio: 'Fresh bio',
          });
        });

        it('leaves a published linked persona to its own claim paths', async () => {
          subprofiles.findOne.mockResolvedValue(
            linkedDraft({ status: SubprofileStatus.Published }),
          );
          stageCreatorProfileInTransaction('robin');

          await service.update('user-1', 'sp-1', { bio: 'Fresh bio' });

          expect(manager.findOne).not.toHaveBeenCalledWith(
            Profile,
            expect.anything(),
          );
          expect(savedSubprofile()).toMatchObject({
            status: SubprofileStatus.Published,
            handle: null,
          });
        });
      });

      it('a link switch stops forwarding for every name the persona released, in both directions', async () => {
        subprofiles.findOne.mockResolvedValue(
          makeSubprofile({
            linkVisibility: SubprofileLinkVisibility.Linked,
            status: SubprofileStatus.Published,
            handle: 'robin-nightform',
          }),
        );
        await service.update('user-1', 'sp-1', {
          linkVisibility: SubprofileLinkVisibility.Unlinked,
        });
        expect(handlesService.stopForwardingFor).toHaveBeenCalledWith(
          manager,
          'sp-1',
        );
        // After the releases, in the same transaction.
        const releaseOrder =
          handlesService.release.mock.invocationCallOrder[0] ?? 0;
        const stopOrder =
          handlesService.stopForwardingFor.mock.invocationCallOrder[0] ?? 0;
        expect(releaseOrder).toBeLessThan(stopOrder);

        handlesService.stopForwardingFor.mockClear();
        subprofiles.findOne.mockResolvedValue(
          completeUnlinked({
            status: SubprofileStatus.Published,
            handle: 'after-dark',
          }),
        );
        stageCreatorProfileInTransaction('robin');
        await service.update('user-1', 'sp-1', {
          linkVisibility: SubprofileLinkVisibility.Linked,
        });
        expect(handlesService.stopForwardingFor).toHaveBeenCalledWith(
          manager,
          'sp-1',
        );
      });

      it('a link switch on a draft with nothing to release still stops forwarding', async () => {
        // A draft that was renamed while published earlier holds no handle
        // now, but its older names may still forward.
        subprofiles.findOne.mockResolvedValue(
          makeSubprofile({
            linkVisibility: SubprofileLinkVisibility.Unlinked,
            status: SubprofileStatus.Draft,
            handle: null,
          }),
        );

        await service.update('user-1', 'sp-1', {
          linkVisibility: SubprofileLinkVisibility.Linked,
        });

        expect(dataSource.transaction).toHaveBeenCalledTimes(1);
        expect(handlesService.release).not.toHaveBeenCalled();
        expect(handlesService.stopForwardingFor).toHaveBeenCalledWith(
          manager,
          'sp-1',
        );
      });

      // PRD-427: a handle change on a published persona keeps it published.
      // One transaction validates the new name, claims it and releases the
      // old one with forwarding (`HandlesService.rename`).
      it('renaming a published linked persona keeps it published and forwards the old name', async () => {
        subprofiles.findOne.mockResolvedValue(
          makeSubprofile({
            linkVisibility: SubprofileLinkVisibility.Linked,
            status: SubprofileStatus.Published,
            handle: 'robin-nightform',
          }),
        );

        await service.update('user-1', 'sp-1', { handle: 'robin-sings' });

        expect(dataSource.transaction).toHaveBeenCalledTimes(1);
        expect(handlesService.isTaken).toHaveBeenCalledWith(
          manager,
          'robin-sings',
          personaOwner,
        );
        expect(handlesService.rename).toHaveBeenCalledWith(
          manager,
          'robin-nightform',
          'robin-sings',
          personaOwner,
        );
        // `rename` releases the old name itself, with forwarding.
        expect(handlesService.release).not.toHaveBeenCalled();
        expect(handlesService.stopForwardingFor).not.toHaveBeenCalled();
        const renameOrder =
          handlesService.rename.mock.invocationCallOrder[0] ?? 0;
        const saveOrder = manager.save.mock.invocationCallOrder[0] ?? 0;
        expect(renameOrder).toBeLessThan(saveOrder);
        expect(savedSubprofile()).toMatchObject({
          linkVisibility: SubprofileLinkVisibility.Linked,
          status: SubprofileStatus.Published,
          handle: 'robin-sings',
        });
      });

      it('renaming a published unlinked persona keeps it published and does not stop forwarding', async () => {
        subprofiles.findOne.mockResolvedValue(
          completeUnlinked({ status: SubprofileStatus.Published }),
        );

        const view = await service.update('user-1', 'sp-1', {
          handle: 'nightform-renamed',
        });

        expect(handlesService.rename).toHaveBeenCalledWith(
          manager,
          'nightform',
          'nightform-renamed',
          personaOwner,
        );
        expect(handlesService.stopForwardingFor).not.toHaveBeenCalled();
        expect(savedSubprofile()).toMatchObject({
          status: SubprofileStatus.Published,
          handle: 'nightform-renamed',
        });
        expect(view.status).toBe(SubprofileStatus.Published);
      });

      it('a rename to a taken handle is a 409 and changes nothing', async () => {
        subprofiles.findOne.mockResolvedValue(
          makeSubprofile({
            linkVisibility: SubprofileLinkVisibility.Linked,
            status: SubprofileStatus.Published,
            handle: 'robin-nightform',
          }),
        );
        handlesService.isTaken.mockResolvedValue(true);

        const rejection = service.update('user-1', 'sp-1', {
          handle: 'robin-sings',
        });

        await expect(rejection).rejects.toBeInstanceOf(ConflictException);
        await rejection.catch((err: ConflictException) => {
          expect(err.getResponse()).toMatchObject({
            code: 'HANDLE_TAKEN',
            unmet: ['handle_taken'],
          });
        });
        expect(handlesService.rename).not.toHaveBeenCalled();
        expect(handlesService.release).not.toHaveBeenCalled();
        expect(manager.save).not.toHaveBeenCalled();
      });

      it('a rename that loses the claim race is the same HANDLE_TAKEN 409 and saves nothing', async () => {
        subprofiles.findOne.mockResolvedValue(
          completeUnlinked({ status: SubprofileStatus.Published }),
        );
        handlesService.rename.mockRejectedValue(
          new ConflictException('That handle is already taken'),
        );

        const rejection = service.update('user-1', 'sp-1', {
          handle: 'nightform-renamed',
        });

        await expect(rejection).rejects.toBeInstanceOf(ConflictException);
        await rejection.catch((err: ConflictException) => {
          expect(err.getResponse()).toMatchObject({
            code: 'HANDLE_TAKEN',
            unmet: ['handle_taken'],
          });
        });
        expect(manager.save).not.toHaveBeenCalled();
      });

      it('a rename to a handle that fails a publish check is a 422 and claims nothing', async () => {
        subprofiles.findOne.mockResolvedValue(
          completeUnlinked({ status: SubprofileStatus.Published }),
        );

        await expect(
          service.update('user-1', 'sp-1', { handle: 'Not A Handle' }),
        ).rejects.toBeInstanceOf(UnprocessableEntityException);

        expect(handlesService.rename).not.toHaveBeenCalled();
        expect(manager.save).not.toHaveBeenCalled();
      });

      it('an unlinked rename to a handle naming the creator is refused with handle_names_owner', async () => {
        subprofiles.findOne.mockResolvedValue(
          completeUnlinked({ status: SubprofileStatus.Published }),
        );
        stageCreatorProfileInTransaction('robin');

        const rejection = service.update('user-1', 'sp-1', {
          handle: 'robin-after-dark',
        });

        await expect(rejection).rejects.toBeInstanceOf(
          UnprocessableEntityException,
        );
        await rejection.catch((err: UnprocessableEntityException) => {
          expect(err.getResponse()).toMatchObject({
            unmet: ['handle_names_owner'],
          });
        });
        expect(handlesService.rename).not.toHaveBeenCalled();
      });

      it('clearing the handle of a published linked persona claims its derived default and keeps it published', async () => {
        subprofiles.findOne.mockResolvedValue(
          makeSubprofile({
            linkVisibility: SubprofileLinkVisibility.Linked,
            status: SubprofileStatus.Published,
            handle: 'robin-sings',
          }),
        );
        stageCreatorProfileInTransaction('robin');

        await service.update('user-1', 'sp-1', { handle: '' });

        expect(handlesService.rename).toHaveBeenCalledWith(
          manager,
          'robin-sings',
          'robin-nightform',
          personaOwner,
        );
        expect(savedSubprofile()).toMatchObject({
          status: SubprofileStatus.Published,
          handle: 'robin-nightform',
        });
      });

      it('clearing the handle of a published unlinked persona is refused and changes nothing', async () => {
        subprofiles.findOne.mockResolvedValue(
          completeUnlinked({ status: SubprofileStatus.Published }),
        );

        await expect(
          service.update('user-1', 'sp-1', { handle: '' }),
        ).rejects.toBeInstanceOf(UnprocessableEntityException);

        expect(handlesService.rename).not.toHaveBeenCalled();
        expect(manager.save).not.toHaveBeenCalled();
      });

      it('refuses a rename with a 409 before touching the registry when the persona was unpublished meanwhile', async () => {
        subprofiles.findOne.mockResolvedValue(
          completeUnlinked({ status: SubprofileStatus.Published }),
        );
        manager.findOne.mockResolvedValue(
          completeUnlinked({ status: SubprofileStatus.Draft, handle: null }),
        );

        await expect(
          service.update('user-1', 'sp-1', { handle: 'nightform-renamed' }),
        ).rejects.toBeInstanceOf(ConflictException);

        expect(handlesService.isTaken).not.toHaveBeenCalled();
        expect(handlesService.rename).not.toHaveBeenCalled();
        expect(manager.save).not.toHaveBeenCalled();
      });

      // A published linked persona the backfill skipped holds no handle and
      // no registry row. A typed handle is validated and claimed at once, so
      // `/p/` only ever serves a registered name.
      it('typing a handle on a published linked persona with no handle claims it and keeps it published', async () => {
        subprofiles.findOne.mockResolvedValue(
          makeSubprofile({
            linkVisibility: SubprofileLinkVisibility.Linked,
            status: SubprofileStatus.Published,
            handle: null,
          }),
        );

        await service.update('user-1', 'sp-1', { handle: 'robin-sings' });

        expect(handlesService.release).not.toHaveBeenCalled();
        expect(handlesService.rename).toHaveBeenCalledWith(
          manager,
          null,
          'robin-sings',
          personaOwner,
        );
        expect(savedSubprofile()).toMatchObject({
          linkVisibility: SubprofileLinkVisibility.Linked,
          status: SubprofileStatus.Published,
          handle: 'robin-sings',
        });
      });

      // ENG-447: nothing that belonged to the named persona carries to the
      // pseudonymous address.
      it('linked to unlinked deletes the followers, endorsements and old nested addresses in the switch transaction', async () => {
        subprofiles.findOne.mockResolvedValue(
          makeSubprofile({
            linkVisibility: SubprofileLinkVisibility.Linked,
            status: SubprofileStatus.Published,
            handle: 'robin-nightform',
          }),
        );

        await service.update('user-1', 'sp-1', {
          linkVisibility: SubprofileLinkVisibility.Unlinked,
        });

        expect(dataSource.transaction).toHaveBeenCalledTimes(1);
        expect(manager.delete).toHaveBeenCalledWith(SubprofileFollower, {
          subprofileId: 'sp-1',
        });
        expect(manager.delete).toHaveBeenCalledWith(SubprofileEndorsement, {
          subprofileId: 'sp-1',
        });
        expect(manager.delete).toHaveBeenCalledWith(SubprofileAddressHistory, {
          subprofileId: 'sp-1',
        });
        const deleteOrder = manager.delete.mock.invocationCallOrder[0] ?? 0;
        const saveOrder = manager.save.mock.invocationCallOrder[0] ?? 0;
        expect(deleteOrder).toBeLessThan(saveOrder);
      });

      it('linked to unlinked keeps every follower and endorsement when the switch is refused', async () => {
        subprofiles.findOne.mockResolvedValue(
          makeSubprofile({
            linkVisibility: SubprofileLinkVisibility.Linked,
            status: SubprofileStatus.Published,
            handle: 'robin-nightform',
          }),
        );
        // A former creator: the lock refuses before anything is written.
        manager.findOne.mockResolvedValue(
          makeSubprofile({
            userId: 'successor-1',
            linkVisibility: SubprofileLinkVisibility.Linked,
            status: SubprofileStatus.Published,
            handle: 'robin-nightform',
          }),
        );

        await expect(
          service.update('user-1', 'sp-1', {
            linkVisibility: SubprofileLinkVisibility.Unlinked,
          }),
        ).rejects.toBeInstanceOf(ForbiddenException);

        expect(manager.delete).not.toHaveBeenCalled();
      });

      // ENG-447: the pseudonymous persona answers under a fresh id, so no id
      // the named persona exposed leads to it.
      describe('the fresh id an unlink issues', () => {
        const REKEY_SQL = `UPDATE "subprofiles" SET "id" = $1 WHERE "id" = $2`;
        const UUID_PATTERN =
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
        const rekeyCallIndex = () =>
          manager.query.mock.calls.findIndex(
            ([sql]: unknown[]) => sql === REKEY_SQL,
          );
        const publishedLinkedPersona = () =>
          makeSubprofile({
            linkVisibility: SubprofileLinkVisibility.Linked,
            status: SubprofileStatus.Published,
            handle: 'robin-nightform',
          });

        it('moves the row to a new id after the cut, and saves and answers under it', async () => {
          subprofiles.findOne.mockResolvedValue(publishedLinkedPersona());

          const view = await service.update('user-1', 'sp-1', {
            linkVisibility: SubprofileLinkVisibility.Unlinked,
          });

          const freshId = savedSubprofile().id;
          expect(freshId).not.toBe('sp-1');
          expect(freshId).toMatch(UUID_PATTERN);
          expect(view.id).toBe(freshId);
          expect(manager.query).toHaveBeenCalledWith(REKEY_SQL, [
            freshId,
            'sp-1',
          ]);
          // The registry release and the cut name the old id, and both run
          // before the re-key; the save comes after it.
          expect(handlesService.release).toHaveBeenCalledWith(
            manager,
            'robin-nightform',
            personaOwner,
            { isForwarding: false },
          );
          expect(manager.delete).toHaveBeenCalledWith(SubprofileFollower, {
            subprofileId: 'sp-1',
          });
          const rekeyOrder =
            manager.query.mock.invocationCallOrder[rekeyCallIndex()] ?? 0;
          const deleteOrder = manager.delete.mock.invocationCallOrder[0] ?? 0;
          const saveOrder = manager.save.mock.invocationCallOrder[0] ?? 0;
          expect(deleteOrder).toBeLessThan(rekeyOrder);
          expect(rekeyOrder).toBeLessThan(saveOrder);
        });

        // An invitee knows the named persona; accepting would show them the
        // pseudonymous one and its new id.
        it('revokes the pending co-owner invites in the switch transaction', async () => {
          subprofiles.findOne.mockResolvedValue(publishedLinkedPersona());

          await service.update('user-1', 'sp-1', {
            linkVisibility: SubprofileLinkVisibility.Unlinked,
          });

          expect(manager.update).toHaveBeenCalledWith(
            SubprofileInvite,
            { subprofileId: 'sp-1', status: SubprofileInviteStatus.Pending },
            {
              status: SubprofileInviteStatus.Revoked,
              respondedAt: expect.any(Date) as unknown,
            },
          );
          const revokeOrder =
            manager.update.mock.invocationCallOrder[
              manager.update.mock.calls.findIndex(
                ([entity]: unknown[]) => entity === SubprofileInvite,
              )
            ] ?? 0;
          const rekeyOrder =
            manager.query.mock.invocationCallOrder[rekeyCallIndex()] ?? 0;
          expect(revokeOrder).toBeLessThan(rekeyOrder);
        });

        // The messaging identity goes the way a persona delete takes it: its
        // seats and blocks cascade, and each correspondent's old thread shows
        // the former-mailbox author. Deleted under the old id, before the
        // re-key.
        it('deletes the messaging identity before the re-key', async () => {
          subprofiles.findOne.mockResolvedValue(publishedLinkedPersona());

          await service.update('user-1', 'sp-1', {
            linkVisibility: SubprofileLinkVisibility.Unlinked,
          });

          expect(manager.delete).toHaveBeenCalledWith(Identity, {
            kind: IdentityKind.Subprofile,
            subprofileId: 'sp-1',
          });
          const identityDeleteOrder =
            manager.delete.mock.invocationCallOrder[
              manager.delete.mock.calls.findIndex(
                ([entity]: unknown[]) => entity === Identity,
              )
            ] ?? 0;
          const rekeyOrder =
            manager.query.mock.invocationCallOrder[rekeyCallIndex()] ?? 0;
          expect(identityDeleteOrder).toBeGreaterThan(0);
          expect(identityDeleteOrder).toBeLessThan(rekeyOrder);
        });

        // A member's block of the persona identity must outlive the identity:
        // it is carried to the persona before the identity row goes.
        it('carries the blocks on the messaging identity to the persona before deleting it', async () => {
          subprofiles.findOne.mockResolvedValue(publishedLinkedPersona());

          await service.update('user-1', 'sp-1', {
            linkVisibility: SubprofileLinkVisibility.Unlinked,
          });

          const carryCallIndex = manager.query.mock.calls.findIndex(
            ([sql]: unknown[]) =>
              typeof sql === 'string' &&
              sql.includes('UPDATE "identity_blocks"'),
          );
          expect(carryCallIndex).toBeGreaterThanOrEqual(0);
          const carryCall = manager.query.mock.calls[carryCallIndex] as
            unknown[] | undefined;
          expect(carryCall?.[1]).toEqual(['sp-1']);
          const carryOrder =
            manager.query.mock.invocationCallOrder[carryCallIndex] ?? 0;
          const identityDeleteOrder =
            manager.delete.mock.invocationCallOrder[
              manager.delete.mock.calls.findIndex(
                ([entity]: unknown[]) => entity === Identity,
              )
            ] ?? 0;
          expect(carryOrder).toBeLessThan(identityDeleteOrder);
        });

        it('keeps the messaging identity when the persona is linked or the unlink is refused', async () => {
          subprofiles.findOne.mockResolvedValue(
            completeUnlinked({
              status: SubprofileStatus.Published,
              handle: 'after-dark',
            }),
          );
          stageCreatorProfileInTransaction('robin');
          await service.update('user-1', 'sp-1', {
            linkVisibility: SubprofileLinkVisibility.Linked,
          });

          subprofiles.findOne.mockResolvedValue(publishedLinkedPersona());
          manager.findOne.mockResolvedValue(
            makeSubprofile({
              userId: 'successor-1',
              linkVisibility: SubprofileLinkVisibility.Linked,
              status: SubprofileStatus.Published,
              handle: 'robin-nightform',
            }),
          );
          await expect(
            service.update('user-1', 'sp-1', {
              linkVisibility: SubprofileLinkVisibility.Unlinked,
            }),
          ).rejects.toBeInstanceOf(ForbiddenException);

          expect(manager.delete).not.toHaveBeenCalledWith(
            Identity,
            expect.anything(),
          );
        });

        it('keeps the pending invites when the persona is linked or the unlink is refused', async () => {
          subprofiles.findOne.mockResolvedValue(
            completeUnlinked({
              status: SubprofileStatus.Published,
              handle: 'after-dark',
            }),
          );
          stageCreatorProfileInTransaction('robin');
          await service.update('user-1', 'sp-1', {
            linkVisibility: SubprofileLinkVisibility.Linked,
          });

          subprofiles.findOne.mockResolvedValue(publishedLinkedPersona());
          manager.findOne.mockResolvedValue(
            makeSubprofile({
              userId: 'successor-1',
              linkVisibility: SubprofileLinkVisibility.Linked,
              status: SubprofileStatus.Published,
              handle: 'robin-nightform',
            }),
          );
          await expect(
            service.update('user-1', 'sp-1', {
              linkVisibility: SubprofileLinkVisibility.Unlinked,
            }),
          ).rejects.toBeInstanceOf(ForbiddenException);

          expect(manager.update).not.toHaveBeenCalledWith(
            SubprofileInvite,
            expect.anything(),
            expect.anything(),
          );
        });

        it('leaves the old id resolving nothing and the new id resolving the persona', async () => {
          // A one-table stand-in for `subprofiles`: the re-key moves the row
          // from its old id to the new one, as the UPDATE does.
          const rowsById = new Map<string, Subprofile>([
            ['sp-1', publishedLinkedPersona()],
          ]);
          subprofiles.findOne.mockImplementation((options: unknown) => {
            const { where } = options as { where: { id: string } };
            const row = rowsById.get(where.id);
            return Promise.resolve(row ? { ...row } : null);
          });
          manager.query.mockImplementation(
            (sql: unknown, parameters?: unknown) => {
              if (sql === REKEY_SQL) {
                const [freshId, previousId] = parameters as [string, string];
                const row = rowsById.get(previousId);
                rowsById.delete(previousId);
                if (row) {
                  rowsById.set(freshId, { ...row, id: freshId });
                }
              }
              return Promise.resolve(undefined);
            },
          );

          const unlinked = await service.update('user-1', 'sp-1', {
            linkVisibility: SubprofileLinkVisibility.Unlinked,
          });

          await expect(
            service.getOwnedDTO('user-1', 'sp-1'),
          ).rejects.toBeInstanceOf(NotFoundException);
          const reloaded = await service.getOwnedDTO('user-1', unlinked.id);
          expect(reloaded.id).toBe(unlinked.id);
          expect(unlinked.id).not.toBe('sp-1');
        });

        it('keeps the id when the persona is linked', async () => {
          subprofiles.findOne.mockResolvedValue(
            completeUnlinked({
              status: SubprofileStatus.Published,
              handle: 'after-dark',
            }),
          );
          stageCreatorProfileInTransaction('robin');

          const view = await service.update('user-1', 'sp-1', {
            linkVisibility: SubprofileLinkVisibility.Linked,
          });

          expect(rekeyCallIndex()).toBe(-1);
          expect(view.id).toBe('sp-1');
        });

        it('keeps the id on an edit that leaves an unlinked persona unlinked', async () => {
          subprofiles.findOne.mockResolvedValue(completeUnlinked());

          const view = await service.update('user-1', 'sp-1', {
            linkVisibility: SubprofileLinkVisibility.Unlinked,
            tagline: 'Late sets, low light',
          });

          expect(rekeyCallIndex()).toBe(-1);
          expect(view.id).toBe('sp-1');
        });

        it('keeps the old id when the unlink is refused', async () => {
          subprofiles.findOne.mockResolvedValue(publishedLinkedPersona());
          // A former creator: the lock refuses before anything is written.
          manager.findOne.mockResolvedValue(
            makeSubprofile({
              userId: 'successor-1',
              linkVisibility: SubprofileLinkVisibility.Linked,
              status: SubprofileStatus.Published,
              handle: 'robin-nightform',
            }),
          );

          await expect(
            service.update('user-1', 'sp-1', {
              linkVisibility: SubprofileLinkVisibility.Unlinked,
            }),
          ).rejects.toBeInstanceOf(ForbiddenException);

          expect(rekeyCallIndex()).toBe(-1);
        });
      });

      it('unlinked to linked keeps the followers and endorsements', async () => {
        subprofiles.findOne.mockResolvedValue(
          completeUnlinked({
            status: SubprofileStatus.Published,
            handle: 'after-dark',
          }),
        );
        stageCreatorProfileInTransaction('robin');

        await service.update('user-1', 'sp-1', {
          linkVisibility: SubprofileLinkVisibility.Linked,
        });

        expect(manager.delete).not.toHaveBeenCalledWith(
          SubprofileFollower,
          expect.anything(),
        );
        expect(manager.delete).not.toHaveBeenCalledWith(
          SubprofileEndorsement,
          expect.anything(),
        );
      });

      it('refuses a co-owner editing the handle of a published linked persona', async () => {
        subprofiles.findOne.mockResolvedValue(
          makeSubprofile({
            userId: 'creator-1',
            linkVisibility: SubprofileLinkVisibility.Linked,
            status: SubprofileStatus.Published,
            handle: 'robin-nightform',
          }),
        );

        await expect(
          service.update('user-1', 'sp-1', { handle: 'robin-sings' }),
        ).rejects.toThrow(
          new ForbiddenException(
            'Only the persona creator can change its handle',
          ),
        );

        expect(handlesService.release).not.toHaveBeenCalled();
      });
    });

    // Linking (Unlinked to Linked) nests the persona under the creator's
    // profile and shows the creator's name, so only the creator
    // (`subprofiles.userId`) may make that switch. Unlinking keeps its
    // earlier rules.
    describe('linking to the creator profile is creator-only', () => {
      const linkRefusal = new ForbiddenException(
        'Only the persona creator can link it to their profile',
      );

      it('refuses a co-owner who is not the creator, and saves nothing', async () => {
        subprofiles.findOne.mockResolvedValue(
          makeSubprofile({
            userId: 'creator-1',
            linkVisibility: SubprofileLinkVisibility.Unlinked,
            status: SubprofileStatus.Draft,
            handle: null,
          }),
        );

        await expect(
          service.update('user-1', 'sp-1', {
            linkVisibility: SubprofileLinkVisibility.Linked,
          }),
        ).rejects.toThrow(linkRefusal);

        expect(manager.save).not.toHaveBeenCalled();
        expect(subprofiles.save).not.toHaveBeenCalled();
        expect(dataSource.transaction).not.toHaveBeenCalled();
      });

      it('refuses a co-owner linking a published unlinked persona with the link reason, and releases nothing', async () => {
        subprofiles.findOne.mockResolvedValue(
          completeUnlinked({
            userId: 'creator-1',
            status: SubprofileStatus.Published,
          }),
        );

        await expect(
          service.update('user-1', 'sp-1', {
            linkVisibility: SubprofileLinkVisibility.Linked,
          }),
        ).rejects.toThrow(linkRefusal);

        expect(handlesService.release).not.toHaveBeenCalled();
        expect(manager.save).not.toHaveBeenCalled();
      });

      it('lets the creator link it', async () => {
        subprofiles.findOne.mockResolvedValue(
          makeSubprofile({
            userId: 'user-1',
            linkVisibility: SubprofileLinkVisibility.Unlinked,
            status: SubprofileStatus.Draft,
            handle: null,
          }),
        );

        await service.update('user-1', 'sp-1', {
          linkVisibility: SubprofileLinkVisibility.Linked,
        });

        const saved = (manager.save.mock.calls[0] as [Subprofile])[0];
        expect(saved.linkVisibility).toBe(SubprofileLinkVisibility.Linked);
        expect(saved.userId).toBe('user-1');
      });

      it('lets a co-owner unlink a linked draft, as before', async () => {
        subprofiles.findOne.mockResolvedValue(
          makeSubprofile({
            userId: 'creator-1',
            linkVisibility: SubprofileLinkVisibility.Linked,
            status: SubprofileStatus.Draft,
            handle: null,
          }),
        );

        await service.update('user-1', 'sp-1', {
          linkVisibility: SubprofileLinkVisibility.Unlinked,
        });

        const saved = (manager.save.mock.calls[0] as [Subprofile])[0];
        expect(saved.linkVisibility).toBe(SubprofileLinkVisibility.Unlinked);
        expect(saved.status).toBe(SubprofileStatus.Draft);
      });

      it('still refuses a co-owner unlinking a published persona with the unpublish reason, as before', async () => {
        subprofiles.findOne.mockResolvedValue(
          makeSubprofile({
            userId: 'creator-1',
            linkVisibility: SubprofileLinkVisibility.Linked,
            status: SubprofileStatus.Published,
            handle: null,
          }),
        );

        await expect(
          service.update('user-1', 'sp-1', {
            linkVisibility: SubprofileLinkVisibility.Unlinked,
          }),
        ).rejects.toThrow(
          new ForbiddenException('Only the persona creator can unpublish it'),
        );

        expect(manager.save).not.toHaveBeenCalled();
      });

      it('refuses a former creator who handed the persona over', async () => {
        // The handover committed before this load: `userId` already names
        // the successor, and the former creator is now a plain co-owner.
        subprofiles.findOne.mockResolvedValue(
          makeSubprofile({
            userId: 'successor-1',
            linkVisibility: SubprofileLinkVisibility.Unlinked,
            status: SubprofileStatus.Draft,
            handle: null,
          }),
        );

        await expect(
          service.update('user-1', 'sp-1', {
            linkVisibility: SubprofileLinkVisibility.Linked,
          }),
        ).rejects.toThrow(linkRefusal);

        expect(manager.save).not.toHaveBeenCalled();
      });

      it('re-checks the creator under the row lock and refuses when the creator changed between load and save', async () => {
        subprofiles.findOne.mockResolvedValue(
          makeSubprofile({
            userId: 'user-1',
            linkVisibility: SubprofileLinkVisibility.Unlinked,
            status: SubprofileStatus.Draft,
            handle: null,
          }),
        );
        // The creator transfer committed after the load above.
        manager.findOne.mockResolvedValue(
          makeSubprofile({
            userId: 'successor-1',
            linkVisibility: SubprofileLinkVisibility.Unlinked,
            status: SubprofileStatus.Draft,
            handle: null,
          }),
        );

        await expect(
          service.update('user-1', 'sp-1', {
            linkVisibility: SubprofileLinkVisibility.Linked,
          }),
        ).rejects.toThrow(
          new ForbiddenException(
            'Only the persona creator can make this change',
          ),
        );

        expect(manager.findOne).toHaveBeenCalledWith(Subprofile, {
          where: { id: 'sp-1' },
          lock: { mode: 'pessimistic_write' },
        });
        expect(manager.save).not.toHaveBeenCalled();
      });

      it('an unrelated co-owner edit after a concurrent unlink saves and keeps it unlinked', async () => {
        subprofiles.findOne.mockResolvedValue(
          makeSubprofile({
            userId: 'creator-1',
            linkVisibility: SubprofileLinkVisibility.Linked,
            status: SubprofileStatus.Published,
            handle: null,
          }),
        );
        // The creator unlinked it after the co-owner's load, which also
        // drafted it.
        manager.findOne.mockResolvedValue(
          makeSubprofile({
            userId: 'creator-1',
            linkVisibility: SubprofileLinkVisibility.Unlinked,
            status: SubprofileStatus.Draft,
            handle: null,
          }),
        );

        await service.update('user-1', 'sp-1', { bio: 'Fresh bio' });

        const saved = (manager.save.mock.calls[0] as [Subprofile])[0];
        expect(saved).toMatchObject({
          linkVisibility: SubprofileLinkVisibility.Unlinked,
          status: SubprofileStatus.Draft,
          handle: null,
          bio: 'Fresh bio',
        });
      });

      it('a co-owner resending the loaded link value keeps the committed unlink', async () => {
        subprofiles.findOne.mockResolvedValue(
          makeSubprofile({
            userId: 'creator-1',
            linkVisibility: SubprofileLinkVisibility.Linked,
            status: SubprofileStatus.Draft,
            handle: null,
          }),
        );
        manager.findOne.mockResolvedValue(
          makeSubprofile({
            userId: 'creator-1',
            linkVisibility: SubprofileLinkVisibility.Unlinked,
            status: SubprofileStatus.Draft,
            handle: null,
          }),
        );

        await service.update('user-1', 'sp-1', {
          linkVisibility: SubprofileLinkVisibility.Linked,
          bio: 'Fresh bio',
        });

        const saved = (manager.save.mock.calls[0] as [Subprofile])[0];
        expect(saved.linkVisibility).toBe(SubprofileLinkVisibility.Unlinked);
      });

      it('a creator stale edit does not re-link a persona a co-owner unlinked meanwhile', async () => {
        subprofiles.findOne.mockResolvedValue(
          makeSubprofile({
            userId: 'user-1',
            linkVisibility: SubprofileLinkVisibility.Linked,
            status: SubprofileStatus.Draft,
            handle: null,
          }),
        );
        // A co-owner unlinked the draft after the creator's load.
        manager.findOne.mockResolvedValue(
          makeSubprofile({
            userId: 'user-1',
            linkVisibility: SubprofileLinkVisibility.Unlinked,
            status: SubprofileStatus.Draft,
            handle: null,
          }),
        );

        await service.update('user-1', 'sp-1', { bio: 'Fresh bio' });

        const saved = (manager.save.mock.calls[0] as [Subprofile])[0];
        expect(saved).toMatchObject({
          linkVisibility: SubprofileLinkVisibility.Unlinked,
          bio: 'Fresh bio',
        });
      });

      it('an explicit link by a co-owner is still refused when the committed row is unlinked', async () => {
        subprofiles.findOne.mockResolvedValue(
          makeSubprofile({
            userId: 'creator-1',
            linkVisibility: SubprofileLinkVisibility.Unlinked,
            status: SubprofileStatus.Draft,
            handle: null,
          }),
        );
        manager.findOne.mockResolvedValue(
          makeSubprofile({
            userId: 'creator-1',
            linkVisibility: SubprofileLinkVisibility.Unlinked,
            status: SubprofileStatus.Draft,
            handle: null,
          }),
        );

        await expect(
          service.update('user-1', 'sp-1', {
            linkVisibility: SubprofileLinkVisibility.Linked,
          }),
        ).rejects.toThrow(linkRefusal);

        expect(manager.save).not.toHaveBeenCalled();
      });

      it('refuses a linked publish with a 409 when the persona was unlinked meanwhile', async () => {
        subprofiles.findOne.mockResolvedValue(
          makeSubprofile({
            userId: 'creator-1',
            linkVisibility: SubprofileLinkVisibility.Linked,
            status: SubprofileStatus.Draft,
            handle: null,
          }),
        );
        manager.findOne.mockResolvedValue(
          makeSubprofile({
            userId: 'creator-1',
            linkVisibility: SubprofileLinkVisibility.Unlinked,
            status: SubprofileStatus.Draft,
            handle: null,
          }),
        );
        items.find.mockResolvedValue([]);

        await expect(service.publish('user-1', 'sp-1')).rejects.toBeInstanceOf(
          ConflictException,
        );

        expect(manager.save).not.toHaveBeenCalled();
      });

      const changedMeanwhileMessage =
        'This persona changed while you were editing. Reload it and try again.';

      it('refuses a creator handle edit with a 409 when the persona was linked meanwhile', async () => {
        subprofiles.findOne.mockResolvedValue(
          completeUnlinked({
            userId: 'user-1',
            status: SubprofileStatus.Published,
          }),
        );
        // The creator linked it from another tab after this load.
        manager.findOne.mockResolvedValue(
          makeSubprofile({
            userId: 'user-1',
            linkVisibility: SubprofileLinkVisibility.Linked,
            status: SubprofileStatus.Published,
            handle: null,
          }),
        );

        await expect(
          service.update('user-1', 'sp-1', { handle: 'nightform-renamed' }),
        ).rejects.toThrow(new ConflictException(changedMeanwhileMessage));

        // The release ran inside the transaction the 409 rolls back.
        expect(manager.save).not.toHaveBeenCalled();
      });

      it('refuses a creator unpublish of a linked persona with a 409 when it was unlinked meanwhile', async () => {
        subprofiles.findOne.mockResolvedValue(
          makeSubprofile({
            userId: 'user-1',
            linkVisibility: SubprofileLinkVisibility.Linked,
            status: SubprofileStatus.Published,
            handle: null,
          }),
        );
        manager.findOne.mockResolvedValue(
          makeSubprofile({
            userId: 'user-1',
            linkVisibility: SubprofileLinkVisibility.Unlinked,
            status: SubprofileStatus.Draft,
            handle: null,
          }),
        );

        await expect(service.unpublish('user-1', 'sp-1')).rejects.toThrow(
          new ConflictException(changedMeanwhileMessage),
        );

        expect(manager.save).not.toHaveBeenCalled();
      });

      it('refuses an unlinked publish with a 409 before claiming the handle when the creator linked it meanwhile', async () => {
        subprofiles.findOne.mockResolvedValue(
          completeUnlinked({
            userId: 'creator-1',
            status: SubprofileStatus.Draft,
          }),
        );
        items.find.mockResolvedValue(contentItems(MIN_CONTENT_ITEMS));
        // The creator linked it after the co-owner's load, which dropped
        // the handle.
        manager.findOne.mockResolvedValue(
          makeSubprofile({
            userId: 'creator-1',
            linkVisibility: SubprofileLinkVisibility.Linked,
            status: SubprofileStatus.Draft,
            handle: null,
          }),
        );

        const publishing = service.publish('user-1', 'sp-1');

        // The 409 passes the catch that maps a registry conflict to the
        // 422 `handle_taken`.
        await expect(publishing).rejects.toThrow(
          new ConflictException(changedMeanwhileMessage),
        );
        expect(handlesService.rename).not.toHaveBeenCalled();
        expect(manager.update).not.toHaveBeenCalled();
      });

      it('refuses a creator link with a 409 when the persona was published unlinked meanwhile', async () => {
        subprofiles.findOne.mockResolvedValue(
          completeUnlinked({
            userId: 'user-1',
            status: SubprofileStatus.Draft,
          }),
        );
        // A co-owner's publish claimed the handle after this load.
        manager.findOne.mockResolvedValue(
          completeUnlinked({
            userId: 'user-1',
            status: SubprofileStatus.Published,
          }),
        );

        await expect(
          service.update('user-1', 'sp-1', {
            linkVisibility: SubprofileLinkVisibility.Linked,
          }),
        ).rejects.toThrow(new ConflictException(changedMeanwhileMessage));

        expect(manager.save).not.toHaveBeenCalled();
      });

      it('treats a null linkVisibility in the body as no switch and keeps the committed unlink', async () => {
        subprofiles.findOne.mockResolvedValue(
          makeSubprofile({
            userId: 'creator-1',
            linkVisibility: SubprofileLinkVisibility.Linked,
            status: SubprofileStatus.Draft,
            handle: null,
          }),
        );
        manager.findOne.mockResolvedValue(
          makeSubprofile({
            userId: 'creator-1',
            linkVisibility: SubprofileLinkVisibility.Unlinked,
            status: SubprofileStatus.Draft,
            handle: null,
          }),
        );

        await service.update('user-1', 'sp-1', {
          // `@IsOptional()` lets a JSON null through validation.
          linkVisibility: null as unknown as SubprofileLinkVisibility,
          bio: 'Fresh bio',
        });

        const saved = (manager.save.mock.calls[0] as [Subprofile])[0];
        expect(saved.linkVisibility).toBe(SubprofileLinkVisibility.Unlinked);
      });

      it('publishing an unlinked persona as a co-owner keeps it unlinked', async () => {
        subprofiles.findOne.mockResolvedValue(
          completeUnlinked({
            userId: 'creator-1',
            status: SubprofileStatus.Draft,
          }),
        );
        items.find.mockResolvedValue(contentItems(MIN_CONTENT_ITEMS));

        const published = await service.publish('user-1', 'sp-1');

        expect(published.linkVisibility).toBe(
          SubprofileLinkVisibility.Unlinked,
        );
        expect(manager.update).toHaveBeenCalledWith(
          Subprofile,
          { id: 'sp-1' },
          { status: SubprofileStatus.Published, handle: 'nightform' },
        );
        expect(manager.save).not.toHaveBeenCalled();
      });

      it('publishing an already linked persona as a co-owner keeps its current rule', async () => {
        subprofiles.findOne.mockResolvedValue(
          makeSubprofile({
            userId: 'creator-1',
            linkVisibility: SubprofileLinkVisibility.Linked,
            status: SubprofileStatus.Draft,
            handle: null,
          }),
        );
        items.find.mockResolvedValue([]);

        const published = await service.publish('user-1', 'sp-1');

        expect(published.status).toBe(SubprofileStatus.Published);
        expect(published.linkVisibility).toBe(SubprofileLinkVisibility.Linked);
      });
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
      const saved = (manager.save.mock.calls[0] as [Subprofile])[0];
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
  // `subprofiles.findOne` + `members.findOne` pair gates the reads, since
  // `listRevisions`/`getRevision` open with `this.getOwned(userId,
  // subprofileId)`, the SAME 404/403 owner/co-owner check `replaceSection`
  // uses. `restoreRevision` gets the same 404/403 from the persona row lock
  // it takes first (ENG-451), so its tests stage the locked `Subprofile`
  // read on `manager.findOne`.
  describe('item revisions (Protect Your Work, Task 8)', () => {
    // The persona row the restore's locked read returns.
    const lockedPersona = (overrides: Partial<Subprofile> = {}) =>
      makeSubprofile({
        id: 'sp-1',
        userId: 'creator-1',
        editVersion: 4,
        ...overrides,
      });

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
        if (entity === Subprofile) return Promise.resolve(lockedPersona());
        if (entity === SubprofileItem) return Promise.resolve(currentItem);
        if (entity === SubprofileItemRevision) return Promise.resolve(revision);
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
        (revisionCreateCall![1].snapshot as unknown as { title: string }).title,
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
      manager.findOne.mockImplementation((entity: unknown) =>
        Promise.resolve(entity === Subprofile ? lockedPersona() : null),
      );
      await expect(
        service.restoreRevision('user-1', 'sp-1', 'missing-item', 'rev-1'),
      ).rejects.toThrow(new NotFoundException('Item not found'));
    });

    // ENG-451: a restore takes the persona row lock and raises
    // `edit_version` like the four editor writes, so a restore built on a
    // stale version is refused before any item row is read or written.
    describe('edit version (ENG-451)', () => {
      const stageRestorableItem = (storedEditVersion: number) => {
        const revision = {
          id: 'rev-1',
          itemId: 'it-1',
          subprofileId: 'sp-1',
          section: SubprofileSection.Projects,
          createdAt: new Date('2026-01-01T00:00:00Z'),
          snapshot: editableSnapshot(makeItem({ title: 'A' })),
        };
        manager.findOne.mockImplementation((entity: unknown) => {
          if (entity === Subprofile) {
            return Promise.resolve(
              lockedPersona({ editVersion: storedEditVersion }),
            );
          }
          if (entity === SubprofileItem) {
            return Promise.resolve(
              makeItem({ id: 'it-1', subprofileId: 'sp-1', title: 'B' }),
            );
          }
          if (entity === SubprofileItemRevision) {
            return Promise.resolve(revision);
          }
          return Promise.resolve(null);
        });
      };

      it('refuses a stale expected version with a 409 and changes nothing', async () => {
        stageRestorableItem(5);

        const error: unknown = await service
          .restoreRevision('user-1', 'sp-1', 'it-1', 'rev-1', 4)
          .then(
            () => undefined,
            (rejection: unknown) => rejection,
          );

        expect(error).toBeInstanceOf(ConflictException);
        expect((error as ConflictException).getResponse()).toMatchObject({
          code: 'PERSONA_EDIT_CONFLICT',
          currentEditVersion: 5,
        });
        expect(manager.findOne).not.toHaveBeenCalledWith(
          SubprofileItem,
          expect.anything(),
        );
        expect(manager.save).not.toHaveBeenCalled();
        expect(manager.update).not.toHaveBeenCalled();
        expect(manager.create).not.toHaveBeenCalled();
      });

      it('locks the persona first, raises the version by 1 and returns it on a match', async () => {
        stageRestorableItem(4);

        const editVersion = await service.restoreRevision(
          'user-1',
          'sp-1',
          'it-1',
          'rev-1',
          4,
        );

        expect(manager.findOne.mock.calls[0]).toEqual([
          Subprofile,
          { where: { id: 'sp-1' }, lock: { mode: 'pessimistic_write' } },
        ]);
        expect(manager.update).toHaveBeenCalledWith(
          Subprofile,
          { id: 'sp-1' },
          { editVersion: 5 },
        );
        expect(editVersion).toBe(5);
        expect(manager.save).toHaveBeenCalledWith(
          expect.objectContaining({ id: 'it-1', title: 'A' }),
        );
      });

      it('raises the version with no expected version sent', async () => {
        stageRestorableItem(4);

        const editVersion = await service.restoreRevision(
          'user-1',
          'sp-1',
          'it-1',
          'rev-1',
        );

        expect(manager.update).toHaveBeenCalledWith(
          Subprofile,
          { id: 'sp-1' },
          { editVersion: 5 },
        );
        expect(editVersion).toBe(5);
      });

      it('refuses a member who left meanwhile before touching the item', async () => {
        stageRestorableItem(4);
        manager.count.mockResolvedValue(0);

        await expect(
          service.restoreRevision('user-1', 'sp-1', 'it-1', 'rev-1', 4),
        ).rejects.toThrow(new ForbiddenException('Not your subprofile'));
        expect(manager.save).not.toHaveBeenCalled();
        expect(manager.update).not.toHaveBeenCalled();
      });
    });
  });

  // "Part of" links: the persona's owners must belong to every target. Uses
  // the same `subprofiles.findOne` + `members.findOne` pair as the
  // `getOwned` describe block to pass the owner gate.
  describe('affiliations owner eligibility', () => {
    beforeEach(() => {
      subprofiles.findOne.mockResolvedValue(
        makeSubprofile({ id: 'sp-1', userId: 'user-1' }),
      );
      members.findOne.mockResolvedValue({
        subprofileId: 'sp-1',
        userId: 'user-1',
      });
      affiliationEligibility.ownerIdsFor.mockResolvedValue(
        new Map([['sp-1', ['user-1', 'co-owner-1']]]),
      );
      communitiesRepository.find.mockResolvedValue([
        {
          id: 'community-1',
          slug: 'book-club',
          name: 'Queer Book Club',
          accessTier: AccessTier.Public,
          ownerId: null,
        },
      ]);
      eventsRepository.find.mockResolvedValue([
        {
          id: 'event-1',
          slug: 'pride-picnic',
          title: 'Pride Picnic',
          status: EventStatus.Published,
          visibility: EventVisibility.Public,
          hostId: null,
        },
      ]);
    });

    it('rejects a community no owner belongs to, naming it, and writes nothing', async () => {
      await expect(
        service.replaceAffiliations('user-1', 'sp-1', [
          { targetType: 'community', targetSlug: 'book-club', role: 'member' },
        ]),
      ).rejects.toThrow(
        new BadRequestException(
          `You can only link communities you're a member of. "Queer Book Club" isn't one of them.`,
        ),
      );
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('rejects an event no owner is going to, naming it', async () => {
      await expect(
        service.replaceAffiliations('user-1', 'sp-1', [
          {
            targetType: 'event',
            targetSlug: 'pride-picnic',
            role: 'attending',
          },
        ]),
      ).rejects.toThrow(
        new BadRequestException(
          `You can only link events you're going to. "Pride Picnic" isn't one of them.`,
        ),
      );
    });

    it('rejects an archived community as not visible, even for a member, and writes nothing', async () => {
      communitiesRepository.find.mockResolvedValue([
        {
          id: 'community-1',
          slug: 'book-club',
          name: 'Queer Book Club',
          accessTier: AccessTier.Public,
          ownerId: null,
          archivedAt: new Date('2026-09-01T00:00:00Z'),
        },
      ]);
      affiliationEligibility.eligibleTargetKeys.mockResolvedValue(
        new Set([eligibilityKey('community', 'community-1', 'user-1')]),
      );

      await expect(
        service.replaceAffiliations('user-1', 'sp-1', [
          { targetType: 'community', targetSlug: 'book-club', role: 'member' },
        ]),
      ).rejects.toThrow(
        new BadRequestException(
          'Affiliation target not found or not visible: community:book-club',
        ),
      );
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('saves when a co-owner qualifies for every target', async () => {
      affiliationEligibility.eligibleTargetKeys.mockResolvedValue(
        new Set([
          eligibilityKey('community', 'community-1', 'co-owner-1'),
          eligibilityKey('event', 'event-1', 'co-owner-1'),
        ]),
      );

      await service.replaceAffiliations('user-1', 'sp-1', [
        { targetType: 'community', targetSlug: 'book-club', role: 'member' },
        { targetType: 'event', targetSlug: 'pride-picnic', role: 'attending' },
      ]);

      expect(affiliationEligibility.eligibleTargetKeys).toHaveBeenCalledWith(
        ['user-1', 'co-owner-1'],
        [expect.objectContaining({ id: 'event-1' })],
        ['community-1'],
      );
      expect(manager.delete).toHaveBeenCalledWith(SubprofileAffiliation, {
        subprofileId: 'sp-1',
      });
    });

    it('lists options for the requesting co-owner only, block-checked against the persona userId too', async () => {
      members.findOne.mockResolvedValue({
        subprofileId: 'sp-1',
        userId: 'co-owner-1',
      });
      const options = [
        {
          targetType: 'community',
          targetSlug: 'book-club',
          name: 'Queer Book Club',
          imageUrl: null,
          startsAt: null,
        },
      ];
      affiliationEligibility.listOptions.mockResolvedValue(options);

      await expect(
        service.listAffiliationOptions('co-owner-1', 'sp-1'),
      ).resolves.toEqual(options);
      expect(affiliationEligibility.listOptions).toHaveBeenCalledWith(
        'co-owner-1',
        'user-1',
      );
      // The other owners' memberships are never read for the picker.
      expect(affiliationEligibility.ownerIdsFor).not.toHaveBeenCalled();
    });

    it('403s the options for a non-owner before reading anything', async () => {
      members.findOne.mockResolvedValue(null);

      await expect(
        service.listAffiliationOptions('stranger-1', 'sp-1'),
      ).rejects.toThrow(ForbiddenException);
      expect(affiliationEligibility.listOptions).not.toHaveBeenCalled();
    });
  });

  // ENG-451: the four editor writes carry `expectedEditVersion`, checked
  // under the persona row lock, and each successful one raises
  // `edit_version` by exactly 1.
  describe('editor save conflicts (ENG-451)', () => {
    // The error a pending write rejects with, for reading the 409 body.
    const rejectionOf = async (pending: Promise<unknown>): Promise<unknown> => {
      try {
        await pending;
      } catch (error) {
        return error;
      }
      throw new Error('Expected the write to be refused');
    };
    const expectEditConflict = (error: unknown, currentEditVersion: number) => {
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({
        code: 'PERSONA_EDIT_CONFLICT',
        currentEditVersion,
      });
    };
    const expectNothingWritten = () => {
      expect(manager.save).not.toHaveBeenCalled();
      expect(manager.update).not.toHaveBeenCalled();
      expect(manager.delete).not.toHaveBeenCalled();
      expect(manager.remove).not.toHaveBeenCalled();
    };

    beforeEach(() => {
      // Loaded at version 4 by `getOwned`.
      subprofiles.findOne.mockResolvedValue(makeSubprofile({ editVersion: 4 }));
    });

    describe('update', () => {
      const savedSubprofile = () =>
        (manager.save.mock.calls[0] as [Subprofile])[0];

      it('refuses a stale expected version with a 409 and changes nothing', async () => {
        // A co-owner saved after this editor loaded the persona.
        manager.findOne.mockResolvedValue(makeSubprofile({ editVersion: 5 }));

        const error = await rejectionOf(
          service.update('user-1', 'sp-1', {
            bio: 'Fresh bio',
            expectedEditVersion: 4,
          }),
        );

        expectEditConflict(error, 5);
        expectNothingWritten();
      });

      it('saves a matching expected version and raises the version by 1', async () => {
        const saved = await service.update('user-1', 'sp-1', {
          bio: 'Fresh bio',
          expectedEditVersion: 4,
        });

        expect(savedSubprofile()).toMatchObject({
          bio: 'Fresh bio',
          editVersion: 5,
        });
        expect(saved.editVersion).toBe(5);
      });

      it('saves with no expected version and still raises the version by 1', async () => {
        const saved = await service.update('user-1', 'sp-1', {
          bio: 'Fresh bio',
        });

        expect(savedSubprofile().editVersion).toBe(5);
        expect(saved.editVersion).toBe(5);
      });

      it('never assigns the precondition onto the persona row', async () => {
        await service.update('user-1', 'sp-1', {
          bio: 'Fresh bio',
          expectedEditVersion: 4,
        });

        expect(savedSubprofile()).not.toHaveProperty('expectedEditVersion');
      });

      it('raises the version from the locked row, over a stale loaded copy', async () => {
        manager.findOne.mockResolvedValue(makeSubprofile({ editVersion: 9 }));

        await service.update('user-1', 'sp-1', { bio: 'Fresh bio' });

        expect(savedSubprofile().editVersion).toBe(10);
      });

      it('refuses the second of two saves built on the same version', async () => {
        let storedEditVersion = 4;
        manager.findOne.mockImplementation((entity: unknown) =>
          Promise.resolve(
            entity === Subprofile
              ? makeSubprofile({ editVersion: storedEditVersion })
              : null,
          ),
        );
        manager.save.mockImplementation((saved: unknown) => {
          storedEditVersion = (saved as Subprofile).editVersion;
          return Promise.resolve(saved);
        });

        const first = await service.update('user-1', 'sp-1', {
          bio: 'First tab',
          expectedEditVersion: 4,
        });
        const error = await rejectionOf(
          service.update('user-1', 'sp-1', {
            bio: 'Second tab',
            expectedEditVersion: 4,
          }),
        );

        expect(first.editVersion).toBe(5);
        expectEditConflict(error, 5);
        expect(manager.save).toHaveBeenCalledTimes(1);
        expect(storedEditVersion).toBe(5);
      });

      // The handle paths run their registry work inside the lock's
      // transaction, so a stale version must stop them before any release,
      // rename or forwarding cut.
      const expectNoRegistryWork = () => {
        expect(handlesService.release).not.toHaveBeenCalled();
        expect(handlesService.rename).not.toHaveBeenCalled();
        expect(handlesService.stopForwardingFor).not.toHaveBeenCalled();
      };

      it('refuses a stale published rename before touching the registry', async () => {
        const published = {
          status: SubprofileStatus.Published,
          handle: 'nightform',
        };
        subprofiles.findOne.mockResolvedValue(
          completeUnlinked({ ...published, editVersion: 4 }),
        );
        manager.findOne.mockResolvedValue(
          completeUnlinked({ ...published, editVersion: 5 }),
        );

        const error = await rejectionOf(
          service.update('user-1', 'sp-1', {
            handle: 'nightform-renamed',
            expectedEditVersion: 4,
          }),
        );

        expectEditConflict(error, 5);
        expectNoRegistryWork();
        expectNothingWritten();
      });

      it('refuses a stale link switch before touching the registry', async () => {
        const publishedLinked = {
          linkVisibility: SubprofileLinkVisibility.Linked,
          status: SubprofileStatus.Published,
          handle: 'robin-nightform',
        };
        subprofiles.findOne.mockResolvedValue(
          makeSubprofile({ ...publishedLinked, editVersion: 4 }),
        );
        manager.findOne.mockResolvedValue(
          makeSubprofile({ ...publishedLinked, editVersion: 5 }),
        );

        const error = await rejectionOf(
          service.update('user-1', 'sp-1', {
            linkVisibility: SubprofileLinkVisibility.Unlinked,
            expectedEditVersion: 4,
          }),
        );

        expectEditConflict(error, 5);
        expectNoRegistryWork();
        expectNothingWritten();
      });

      // Publish, unpublish and a creator transfer leave the version alone,
      // so an edit can pass the version check and still find its link,
      // status or handle moved. That 409 carries the same code and the
      // locked row's version, so the editor offers Reload for it too.
      it('answers a handle edit over a row linked meanwhile with the edit conflict code', async () => {
        subprofiles.findOne.mockResolvedValue(
          completeUnlinked({
            status: SubprofileStatus.Published,
            editVersion: 4,
          }),
        );
        manager.findOne.mockResolvedValue(
          makeSubprofile({
            linkVisibility: SubprofileLinkVisibility.Linked,
            status: SubprofileStatus.Published,
            handle: null,
            editVersion: 4,
          }),
        );

        const error = await rejectionOf(
          service.update('user-1', 'sp-1', {
            handle: 'nightform-renamed',
            expectedEditVersion: 4,
          }),
        );

        expectEditConflict(error, 4);
        expect(manager.save).not.toHaveBeenCalled();
      });

      it('answers an unpublish over a row linked meanwhile with the edit conflict code', async () => {
        subprofiles.findOne.mockResolvedValue(
          makeSubprofile({
            status: SubprofileStatus.Published,
            handle: null,
            editVersion: 4,
          }),
        );
        manager.findOne.mockResolvedValue(
          makeSubprofile({
            linkVisibility: SubprofileLinkVisibility.Linked,
            status: SubprofileStatus.Published,
            handle: null,
            editVersion: 7,
          }),
        );

        const error = await rejectionOf(service.unpublish('user-1', 'sp-1'));

        expectEditConflict(error, 7);
        expect(manager.save).not.toHaveBeenCalled();
      });
    });

    describe.each([
      {
        method: 'replaceSection',
        write: (expectedEditVersion?: number) =>
          service.replaceSection(
            'user-1',
            'sp-1',
            'projects',
            [],
            expectedEditVersion,
          ),
      },
      {
        method: 'replaceSocialLinks',
        write: (expectedEditVersion?: number) =>
          service.replaceSocialLinks('user-1', 'sp-1', [], expectedEditVersion),
      },
      {
        method: 'replaceAffiliations',
        write: (expectedEditVersion?: number) =>
          service.replaceAffiliations(
            'user-1',
            'sp-1',
            [],
            expectedEditVersion,
          ),
      },
    ])('$method', ({ write }) => {
      it('refuses a stale expected version with a 409 and changes nothing', async () => {
        manager.findOne.mockResolvedValue(makeSubprofile({ editVersion: 5 }));

        const error = await rejectionOf(write(4));

        expectEditConflict(error, 5);
        expectNothingWritten();
        expect(manager.find).not.toHaveBeenCalled();
      });

      it('saves a matching expected version and raises the version by 1', async () => {
        const saved = await write(4);

        expect(manager.findOne).toHaveBeenCalledWith(Subprofile, {
          where: { id: 'sp-1' },
          lock: { mode: 'pessimistic_write' },
        });
        expect(manager.update).toHaveBeenCalledWith(
          Subprofile,
          { id: 'sp-1' },
          { editVersion: 5 },
        );
        expect(saved.editVersion).toBe(5);
      });

      it('saves with no expected version and still raises the version by 1', async () => {
        const saved = await write();

        expect(manager.update).toHaveBeenCalledWith(
          Subprofile,
          { id: 'sp-1' },
          { editVersion: 5 },
        );
        expect(saved.editVersion).toBe(5);
      });

      it('refuses the second of two saves built on the same version', async () => {
        let storedEditVersion = 4;
        manager.findOne.mockImplementation((entity: unknown) =>
          Promise.resolve(
            entity === Subprofile
              ? makeSubprofile({ editVersion: storedEditVersion })
              : null,
          ),
        );
        manager.update.mockImplementation(
          (
            entity: unknown,
            _criteria: unknown,
            changes: Partial<Subprofile>,
          ) => {
            if (entity === Subprofile && changes.editVersion !== undefined) {
              storedEditVersion = changes.editVersion;
            }
            return Promise.resolve({ affected: 1 });
          },
        );

        const first = await write(4);
        const error = await rejectionOf(write(4));

        expect(first.editVersion).toBe(5);
        expectEditConflict(error, 5);
        expect(storedEditVersion).toBe(5);
        expect(manager.update).toHaveBeenCalledTimes(1);
      });

      it('refuses a member who left meanwhile before writing anything', async () => {
        manager.count.mockResolvedValue(0);

        await expect(write(4)).rejects.toThrow(
          new ForbiddenException('Not your subprofile'),
        );
        expectNothingWritten();
      });
    });

    it('an unpublish keeps the committed version, neither raised nor reverted', async () => {
      subprofiles.findOne.mockResolvedValue(
        makeSubprofile({
          status: SubprofileStatus.Published,
          handle: null,
          editVersion: 4,
        }),
      );
      manager.findOne.mockResolvedValue(
        makeSubprofile({
          status: SubprofileStatus.Published,
          handle: null,
          editVersion: 6,
        }),
      );

      await service.unpublish('user-1', 'sp-1');

      const saved = (manager.save.mock.calls[0] as [Subprofile])[0];
      expect(saved.editVersion).toBe(6);
    });
  });
});
