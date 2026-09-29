import type { Ambassador } from '../ambassadors/entities/ambassador.entity';
import {
  resetImageUrlBaseForTesting,
  setImageUrlBase,
} from '../common/image-url';
import { CommunityType } from '../communities/entities/community.entity';
import { RosterRole } from '../communities/entities/community-member.entity';
import { Profile, ProfileVisibility } from '../users/entities/profile.entity';
import { DIRECTORY_BLURB_MAX_CHARS, truncateAtWord } from './directory-blurb';
import { Activity, ActivityKind } from './entities/activity.entity';
import {
  BoardKind,
  BoardPost,
  BoardPostStatus,
} from './entities/board-post.entity';
import { Shaping, ShapingKind } from './entities/shaping.entity';
import { Skill } from './entities/skill.entity';
import { SocialLink } from './entities/social-link.entity';
import { WorkItem } from './entities/work-item.entity';
import { OpenToEntry } from './open-to';
import {
  ProfileRelations,
  gateAvatarUrl,
  gateLocation,
  sortShapings,
  toFullProfile,
  toLimitedProfile,
  toMemberCard,
  toProfileCard,
} from './profile-response';

const profile = (overrides: Partial<Profile> = {}): Profile =>
  ({
    userId: 'u1',
    slug: 'tiago',
    firstName: 'Tiago',
    lastName: 'Costa',
    pronouns: 'he/they',
    pronunciation: null,
    tagline: 'Fullstack Developer',
    bio: 'a bio',
    bioPt: null,
    location: 'Arroios',
    now: 'building things',
    notHereFor: null,
    avatarUrl: 'https://x/a.png',
    photoVisible: true,
    hoodVisible: true,
    vouchersVisible: true,
    isAmbassadorTagVisible: true,
    visibility: ProfileVisibility.Open,
    openTo: [{ kind: 'preset', id: 'collaborating' }] as OpenToEntry[],
    identities: ['Queer'],
    lookingFor: ['Community & friendship'],
    tags: ['React', 'TypeScript'],
    verified: true,
    joinedAt: new Date('2024-03-01T00:00:00.000Z'),
    ...overrides,
  }) as Profile;

const ambassadorGrant = (overrides: Partial<Ambassador> = {}): Ambassador => ({
  id: 'amb-1',
  userId: 'u1',
  focusArea: 'trans_health',
  grantedById: null,
  grantedAt: new Date('2026-01-15T00:00:00.000Z'),
  grantReason: 'community leadership',
  revokedAt: null,
  revokedById: null,
  revokeReason: null,
  ...overrides,
});

const LONG_BIO =
  "I build things for the web and spend most weekends cooking for more people than my kitchen was designed for. Lately I've been learning to bind books.";

const emptyRels: ProfileRelations = {
  socials: [],
  work: [],
  board: [],
  skills: [],
  groups: [],
  shapings: [],
  activity: [],
  related: [],
  featuredCommunities: [],
};

describe('profile-response mappers', () => {
  beforeEach(() => {
    setImageUrlBase('https://api.test');
  });

  afterEach(() => {
    resetImageUrlBaseForTesting();
  });

  it('converts a storage key to an API files URL', () => {
    const key =
      'avatars/11111111-2222-3333-4444-555555555555/66666666-7777-8888-9999-000000000000.jpg';
    const card = toProfileCard(profile({ avatarUrl: key }), 0);
    expect(card.avatarUrl).toBe(`https://api.test/files/${key}`);
  });

  it('toProfileCard returns exactly the card fields', () => {
    const card = toProfileCard(profile(), 2);
    expect(card).toEqual({
      slug: 'tiago',
      firstName: 'Tiago',
      lastName: 'Costa',
      pronouns: 'he/they',
      pronunciation: null,
      tagline: 'Fullstack Developer',
      avatarUrl: 'https://x/a.png',
      tags: ['React', 'TypeScript'],
      discipline: [],
      profession: [],
      languages: [],
      vouchCount: 2,
    });
  });

  it('toProfileCard carries the privacy settings only for the owner', () => {
    const p = profile({
      visibility: ProfileVisibility.Private,
      photoVisible: false,
      hoodVisible: false,
      vouchersVisible: false,
    });
    expect(toProfileCard(p, 0, { isOwner: true })).toMatchObject({
      visibility: 'private',
      photoVisible: false,
      hoodVisible: false,
      vouchersVisible: false,
    });
  });

  // ENG-444: a card reaches every member, so a stored toggle on it is a list
  // of who hid what. The keys must be ABSENT for a non-owner, the same pin the
  // Ambassador toggle has below.
  it.each(['visibility', 'photoVisible', 'hoodVisible', 'vouchersVisible'])(
    '%s is absent from every card a non-owner receives',
    (key) => {
      const hider = profile({
        visibility: ProfileVisibility.Private,
        photoVisible: false,
        hoodVisible: false,
        vouchersVisible: false,
      });
      expect(key in toProfileCard(hider, 0)).toBe(false);
      expect(
        key in toProfileCard(hider, 0, { shouldIncludeUnlistedWork: true }),
      ).toBe(false);
      expect(key in toMemberCard(hider, 0)).toBe(false);
      expect(key in toMemberCard(hider, 0, false, null)).toBe(false);
    },
  );

  it.each(['photoVisible', 'hoodVisible', 'vouchersVisible'])(
    '%s is absent from a non-owner full or limited profile, and present for the owner',
    (key) => {
      const hider = profile({
        photoVisible: false,
        hoodVisible: false,
        vouchersVisible: false,
      });
      expect(key in toFullProfile(hider, emptyRels, 2)).toBe(false);
      expect(key in toFullProfile(hider, emptyRels, 2, false, true)).toBe(
        false,
      );
      expect(key in toLimitedProfile(hider, 2)).toBe(false);
      expect(key in toFullProfile(hider, emptyRels, 2, true)).toBe(true);
      expect(key in toLimitedProfile(hider, 2, true)).toBe(true);
      expect(key in toMemberCard(hider, 2, true)).toBe(true);
    },
  );

  // The one setting a single-profile read keeps for every viewer: the page's
  // hero eyebrow and the limited note's wording both read it, and `limited`
  // already says the profile is not open to this viewer.
  it('keeps visibility on the full and limited profile for every viewer', () => {
    expect(
      toFullProfile(
        profile({ visibility: ProfileVisibility.Network }),
        emptyRels,
        2,
      ).visibility,
    ).toBe('network');
    expect(
      toLimitedProfile(profile({ visibility: ProfileVisibility.Private }), 2)
        .visibility,
    ).toBe('private');
  });

  it('toFullProfile serializes joinedAt as ISO and carries new scalars', () => {
    const dto = toFullProfile(profile(), emptyRels, 2);
    expect(dto.limited).toBe(false);
    expect(dto.verified).toBe(true);
    expect(dto.joinedAt).toBe('2024-03-01T00:00:00.000Z');
    expect(dto.now).toBe('building things');
    expect(dto.bio).toBe('a bio');
  });

  it('toFullProfile passes the mutual voucher count straight through', () => {
    // The mapper never decides whether the count may be shown, exactly like
    // `activityBand`: `ProfilesService.loadMutualVoucherCount` has already
    // applied the owner and hidden-roster gates. Defaulting to null keeps a
    // caller that forgets the argument on the safe side.
    expect(
      toFullProfile(profile(), emptyRels, 2, false, false, undefined, null, 3)
        .mutualVoucherCount,
    ).toBe(3);
    expect(
      toFullProfile(
        profile(),
        emptyRels,
        2,
        false,
        false,
        undefined,
        null,
        null,
      ).mutualVoucherCount,
    ).toBeNull();
    expect(
      toFullProfile(profile(), emptyRels, 2).mutualVoucherCount,
    ).toBeNull();
  });

  it('toFullProfile exposes private Interests fields only to the owner', () => {
    const owned = toFullProfile(profile(), emptyRels, 2, true);
    expect(owned.identities).toEqual(['Queer']);
    expect(owned.lookingFor).toEqual(['Community & friendship']);

    // Any other viewer of a full (open/network) profile gets empty arrays —
    // and the default (no flag) is the safe, non-owner behaviour.
    const viewed = toFullProfile(profile(), emptyRels, 2);
    expect(viewed.identities).toEqual([]);
    expect(viewed.lookingFor).toEqual([]);
  });

  it('toFullProfile sends the lookingForPublic toggle only to the owner', () => {
    const ownedPublic = toFullProfile(
      profile({ lookingForPublic: true }),
      emptyRels,
      2,
      true,
    );
    expect(ownedPublic.lookingForPublic).toBe(true);

    const ownedPrivate = toFullProfile(
      profile({ lookingForPublic: false }),
      emptyRels,
      2,
      true,
    );
    expect(ownedPrivate.lookingForPublic).toBe(false);
    expect(ownedPrivate.lookingFor).toEqual(['Community & friendship']);

    // A visitor gets the list itself when the member opted in. The stored
    // toggle is absent for a visitor whichever way it is set (ENG-444).
    const viewedPublic = toFullProfile(
      profile({ lookingForPublic: true }),
      emptyRels,
      2,
    );
    expect(viewedPublic).not.toHaveProperty('lookingForPublic');
    expect(viewedPublic.lookingFor).toEqual(['Community & friendship']);

    const viewedPrivate = toFullProfile(
      profile({ lookingForPublic: false }),
      emptyRels,
      2,
    );
    expect(viewedPrivate).not.toHaveProperty('lookingForPublic');
    expect(viewedPrivate.lookingFor).toEqual([]);
  });

  it('toFullProfile exposes hiddenUntil only to the owner', () => {
    const hiddenAt = new Date('2026-08-19T12:00:00.000Z');

    const owned = toFullProfile(
      profile({ hiddenUntil: hiddenAt }),
      emptyRels,
      2,
      true,
    );
    expect(owned.hiddenUntil).toBe('2026-08-19T12:00:00.000Z');

    const ownedNotHidden = toFullProfile(
      profile({ hiddenUntil: null }),
      emptyRels,
      2,
      true,
    );
    expect(ownedNotHidden.hiddenUntil).toBeNull();

    // Never included in the object for a non-owner viewer, mirroring
    // privateNetwork/featuredConsent — it cannot leak on another member's
    // full profile response.
    const viewed = toFullProfile(
      profile({ hiddenUntil: hiddenAt }),
      emptyRels,
      2,
    );
    expect(viewed).not.toHaveProperty('hiddenUntil');
  });

  it('toFullProfile carries the owner ambassador grant, and null when there is none', () => {
    const grant = ambassadorGrant();
    const owned = toFullProfile(
      profile(),
      emptyRels,
      2,
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      grant,
    );
    expect(owned.ambassador).toEqual({
      since: '2026-01-15T00:00:00.000Z',
      focusArea: 'trans_health',
    });

    const ownedNoGrant = toFullProfile(
      profile(),
      emptyRels,
      2,
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      null,
    );
    expect(ownedNoGrant.ambassador).toBeNull();
  });

  it('toFullProfile omits ambassador entirely for a non-owner viewer', () => {
    const viewed = toFullProfile(
      profile(),
      emptyRels,
      2,
      false,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      ambassadorGrant(),
    );
    expect('ambassador' in viewed).toBe(false);
  });

  it('isAmbassadorTagVisible is absent from every card', () => {
    const hiddenTag = profile({ isAmbassadorTagVisible: false });
    expect('isAmbassadorTagVisible' in toProfileCard(hiddenTag, 0)).toBe(false);
    expect(
      'isAmbassadorTagVisible' in
        toProfileCard(hiddenTag, 0, { shouldIncludeUnlistedWork: true }),
    ).toBe(false);
    expect('isAmbassadorTagVisible' in toMemberCard(hiddenTag, 0)).toBe(false);
    expect('isAmbassadorTagVisible' in toLimitedProfile(hiddenTag, 0)).toBe(
      false,
    );
  });

  it('isAmbassadorTagVisible is absent from a non-owner full profile', () => {
    const hiddenTag = profile({ isAmbassadorTagVisible: false });
    const viewedHidden = toFullProfile(hiddenTag, emptyRels, 2, false);
    expect('isAmbassadorTagVisible' in viewedHidden).toBe(false);

    const visibleTag = profile({ isAmbassadorTagVisible: true });
    const viewedVisible = toFullProfile(visibleTag, emptyRels, 2, false);
    expect('isAmbassadorTagVisible' in viewedVisible).toBe(false);
  });

  it('isAmbassadorTagVisible carries the stored value for the owner', () => {
    const hiddenTag = profile({ isAmbassadorTagVisible: false });
    expect(
      toFullProfile(hiddenTag, emptyRels, 2, true).isAmbassadorTagVisible,
    ).toBe(false);

    const visibleTag = profile({ isAmbassadorTagVisible: true });
    expect(
      toFullProfile(visibleTag, emptyRels, 2, true).isAmbassadorTagVisible,
    ).toBe(true);
  });

  it('carries respondsWithin on the full profile', () => {
    const dto = toFullProfile(
      profile(),
      emptyRels,
      2,
      false,
      false,
      undefined,
      null,
      null,
      'fewDays',
    );
    expect(dto.respondsWithin).toBe('fewDays');
  });

  it('defaults respondsWithin to null when the caller passes none', () => {
    expect(toFullProfile(profile(), emptyRels, 2).respondsWithin).toBeNull();
  });

  it('omits respondsWithin from the limited card', () => {
    const card = toLimitedProfile(profile(), 2);
    expect('respondsWithin' in card).toBe(false);
  });

  it('toFullProfile carries bioPt/notHereFor through ungated', () => {
    const dto = toFullProfile(
      profile({ bioPt: 'Uma bio', notHereFor: 'Casual hookups' }),
      emptyRels,
      2,
    );
    expect(dto.bioPt).toBe('Uma bio');
    expect(dto.notHereFor).toBe('Casual hookups');
  });

  it('toFullProfile hides avatarUrl/location from a non-owner viewer when the toggle is off, but always shows the owner', () => {
    const p = profile({
      avatarUrl: 'https://x/a.png',
      location: 'Arroios',
      photoVisible: false,
      hoodVisible: false,
    });

    // The owner sees their own real photo and location regardless of the
    // toggle — the toggle only controls what OTHER people see.
    const owned = toFullProfile(p, emptyRels, 2, true);
    expect(owned.avatarUrl).toBe('https://x/a.png');
    expect(owned.location).toBe('Arroios');
    // The toggle itself is always the true stored value, even for the owner.
    expect(owned.photoVisible).toBe(false);
    expect(owned.hoodVisible).toBe(false);

    // A non-owner, non-vouched-for viewer (the default `isOwner = false`)
    // gets the content suppressed to null — this is the privacy-sensitive
    // gate the whole feature exists for.
    const viewed = toFullProfile(p, emptyRels, 2);
    expect(viewed.avatarUrl).toBeNull();
    expect(viewed.location).toBeNull();
    // The toggles themselves are owner-only (ENG-444): a non-owner gets the
    // gated content and no word on which switch produced it.
    expect('photoVisible' in viewed).toBe(false);
    expect('hoodVisible' in viewed).toBe(false);
  });

  it('toFullProfile shows avatarUrl/location to a non-owner viewer when the toggle is on', () => {
    const p = profile({
      avatarUrl: 'https://x/a.png',
      location: 'Arroios',
      photoVisible: true,
      hoodVisible: true,
    });
    const viewed = toFullProfile(p, emptyRels, 2);
    expect(viewed.avatarUrl).toBe('https://x/a.png');
    expect(viewed.location).toBe('Arroios');
  });

  it('toFullProfile maps relations to their DTO shapes (no position leak)', () => {
    const rels: ProfileRelations = {
      ...emptyRels,
      socials: [
        { platform: 'instagram', urlOrHandle: '@t', position: 0 },
      ] as unknown as SocialLink[],
      work: [
        {
          category: 'Dev',
          title: 'X',
          year: '2022',
          imageUrl: null,
          position: 0,
          links: [{ kind: 'external', href: 'https://example.com' }],
        },
      ] as unknown as WorkItem[],
      board: [
        {
          kind: BoardKind.Offering,
          title: 'Help',
          slug: 'web-dev-help',
          position: 0,
          status: BoardPostStatus.Open,
          closedNote: null,
          closedAt: null,
          expiresAt: new Date('2026-11-01T00:00:00.000Z'),
          createdAt: new Date('2026-08-03T00:00:00.000Z'),
        },
      ] as unknown as BoardPost[],
      skills: [
        { name: 'Web dev', meta: 'React', position: 0 },
      ] as unknown as Skill[],
      groups: [{ name: 'Queer Devs', role: 'Member' }],
      activity: [
        {
          kind: ActivityKind.Event,
          title: "RSVP'd",
          sub: 'Anjos',
          toLink: '/gatherings/x',
          occurredAt: new Date(),
        },
      ] as unknown as Activity[],
      featuredCommunities: [
        {
          slug: 'queer-devs',
          name: 'Queer Devs',
          tagline: 'Ship together',
          type: CommunityType.Professional,
          typeLabel: 'Professional',
          countLabel: '128 members',
          role: RosterRole.Owner,
          tags: ['beginner-friendly'],
          coverImageUrl: 'https://api.test/files/cover.jpg',
          avatarImageUrl: 'https://api.test/files/mark.png',
          activeThisWeek: 12,
        },
      ],
    };
    const dto = toFullProfile(profile(), rels, 0);
    expect(dto.socials[0]).toEqual({
      platform: 'instagram',
      urlOrHandle: '@t',
    });
    expect(dto.work[0]).toEqual({
      category: 'Dev',
      title: 'X',
      year: '2022',
      imageUrl: null,
      links: [{ kind: 'external', href: 'https://example.com' }],
    });
    expect(dto.board[0]).toEqual({
      kind: 'offering',
      title: 'Help',
      slug: 'web-dev-help',
      status: 'open',
      closedNote: null,
      closedAt: null,
      expiresAt: '2026-11-01T00:00:00.000Z',
      createdAt: '2026-08-03T00:00:00.000Z',
    });
    expect(dto.skills[0]).toEqual({ name: 'Web dev', meta: 'React' });
    expect(dto.groups[0]).toEqual({ name: 'Queer Devs', role: 'Member' });
    expect(dto.activity[0]).toEqual({
      kind: 'event',
      title: "RSVP'd",
      sub: 'Anjos',
      to: '/gatherings/x',
    });
    // Featured communities pass through already resolved for display.
    expect(dto.featuredCommunities[0]).toEqual({
      slug: 'queer-devs',
      name: 'Queer Devs',
      tagline: 'Ship together',
      type: 'professional',
      typeLabel: 'Professional',
      countLabel: '128 members',
      role: 'owner',
      tags: ['beginner-friendly'],
      coverImageUrl: 'https://api.test/files/cover.jpg',
      avatarImageUrl: 'https://api.test/files/mark.png',
      activeThisWeek: 12,
    });
  });

  it('toLimitedProfile keeps identity, omits bio/now/location, empties collections', () => {
    const dto = toLimitedProfile(
      profile({ visibility: ProfileVisibility.Private }),
      5,
    );
    expect(dto).toEqual({
      slug: 'tiago',
      firstName: 'Tiago',
      lastName: 'Costa',
      pronouns: 'he/they',
      pronunciation: null,
      tagline: 'Fullstack Developer',
      avatarUrl: 'https://x/a.png',
      tags: ['React', 'TypeScript'],
      discipline: [],
      profession: [],
      languages: [],
      vouchCount: 5,
      visibility: 'private',
      verified: true,
      joinedAt: '2024-03-01T00:00:00.000Z',
      // The limited card carries the trust cue too: it IS the "should I ask to
      // connect?" surface. Null here because this call passes no count, which
      // is the mapper's default. See MutualVoucherCount.
      mutualVoucherCount: null,
      openTo: [],
      socials: [],
      work: [],
      board: [],
      skills: [],
      groups: [],
      shapings: [],
      activity: [],
      related: [],
      featuredCommunities: [],
      limited: true,
    });
  });

  it('toLimitedProfile hides avatarUrl from a non-owner viewer when photoVisible is off, but always shows the owner', () => {
    const p = profile({
      visibility: ProfileVisibility.Private,
      avatarUrl: 'https://x/a.png',
      photoVisible: false,
    });

    // A limited profile is, by definition, almost always seen by a non-owner
    // (that's WHY it's limited) — the default `isOwner = false` must not ship
    // the real avatarUrl alongside `photoVisible: false`, or the response
    // contradicts itself.
    const viewed = toLimitedProfile(p, 5);
    expect(viewed.avatarUrl).toBeNull();
    expect('photoVisible' in viewed).toBe(false);

    // Mirrors toFullProfile/toMemberCard: an owner-preview call still sees
    // their own real photo regardless of the toggle.
    const owned = toLimitedProfile(p, 5, true);
    expect(owned.avatarUrl).toBe('https://x/a.png');
    expect(owned.photoVisible).toBe(false);
  });

  it('toMemberCard exposes location/openTo only for open profiles', () => {
    const openCard = toMemberCard(
      profile({ visibility: ProfileVisibility.Open }),
      1,
    );
    expect(openCard.location).toBe('Arroios');
    expect(openCard.openTo).toEqual([{ kind: 'preset', id: 'collaborating' }]);
  });

  it('toMemberCard blanks location/openTo for network and private cards', () => {
    for (const visibility of [
      ProfileVisibility.Network,
      ProfileVisibility.Private,
    ]) {
      const card = toMemberCard(profile({ visibility }), 1);
      expect(card.location).toBeNull();
      expect(card.openTo).toEqual([]);
      // identity fields are still listed in the directory
      expect(card.slug).toBe('tiago');
    }
  });

  it('toMemberCard hides avatarUrl/location/hood from a non-owner viewer when the toggle is off', () => {
    const p = profile({
      visibility: ProfileVisibility.Open,
      avatarUrl: 'https://x/a.png',
      location: 'Arroios',
      photoVisible: false,
      hoodVisible: false,
    });
    // Default (no isOwner arg) is the safe, non-owner behaviour — the same
    // default toFullProfile uses.
    const card = toMemberCard(p, 1);
    expect(card.avatarUrl).toBeNull();
    expect(card.location).toBeNull();
    expect(card.hood).toBeNull();
    // The toggles themselves stay off a non-owner's card (ENG-444).
    expect('photoVisible' in card).toBe(false);
    expect('hoodVisible' in card).toBe(false);
  });

  it('toMemberCard shows avatarUrl/location/hood to a non-owner viewer when the toggle is on', () => {
    const p = profile({
      visibility: ProfileVisibility.Open,
      avatarUrl: 'https://x/a.png',
      location: 'Arroios',
      photoVisible: true,
      hoodVisible: true,
    });
    const card = toMemberCard(p, 1);
    expect(card.avatarUrl).toBe('https://x/a.png');
    expect(card.location).toBe('Arroios');
  });

  it('toMemberCard shows a member their own real photo/hood in their own search result, even with the toggle off', () => {
    // Directory search never excludes the viewer's own profile from their own
    // results — see ProfilesService.searchMembers. When a member's own row
    // turns up, `isOwner: true` means they see their real photo/hood
    // regardless of their own toggle, same as toFullProfile.
    const p = profile({
      visibility: ProfileVisibility.Open,
      avatarUrl: 'https://x/a.png',
      location: 'Arroios',
      photoVisible: false,
      hoodVisible: false,
    });
    const card = toMemberCard(p, 1, true);
    expect(card.avatarUrl).toBe('https://x/a.png');
    expect(card.location).toBe('Arroios');
  });

  // A member can save `adultWork`/`sexWorker` on "sex work & adult content".
  // It must show on their own card and stay off everybody else's directory
  // card. See professions.ts#UNLISTED_DISCIPLINE_IDS.
  it('toMemberCard strips adultWork/sexWorker for a non-owner viewer, but keeps it for the owner', () => {
    const p = profile({
      discipline: ['healthcare', 'adultWork'],
      profession: ['nurse', 'sexWorker'],
    });

    const viewed = toMemberCard(p, 1);
    expect(viewed.discipline).toEqual(['healthcare']);
    expect(viewed.profession).toEqual(['nurse']);

    const owned = toMemberCard(p, 1, true);
    expect(owned.discipline).toEqual(['healthcare', 'adultWork']);
    expect(owned.profession).toEqual(['nurse', 'sexWorker']);
  });

  it('toLimitedProfile strips adultWork/sexWorker for a non-owner viewer, but keeps it for the owner', () => {
    const p = profile({
      discipline: ['healthcare', 'adultWork'],
      profession: ['nurse', 'sexWorker'],
    });

    const viewed = toLimitedProfile(p, 1);
    expect(viewed.discipline).toEqual(['healthcare']);
    expect(viewed.profession).toEqual(['nurse']);

    const owned = toLimitedProfile(p, 1, true);
    expect(owned.discipline).toEqual(['healthcare', 'adultWork']);
    expect(owned.profession).toEqual(['nurse', 'sexWorker']);
  });

  // toProfileCard is the RAW card every other mapper builds on; the strip
  // lives here (M3) so a future card built on it can't forget to apply it.
  it('toProfileCard strips adultWork/sexWorker by default, and keeps them with shouldIncludeUnlistedWork', () => {
    const p = profile({
      discipline: ['healthcare', 'adultWork'],
      profession: ['nurse', 'sexWorker'],
    });

    const stripped = toProfileCard(p, 1);
    expect(stripped.discipline).toEqual(['healthcare']);
    expect(stripped.profession).toEqual(['nurse']);

    const kept = toProfileCard(p, 1, { shouldIncludeUnlistedWork: true });
    expect(kept.discipline).toEqual(['healthcare', 'adultWork']);
    expect(kept.profession).toEqual(['nurse', 'sexWorker']);
  });

  // Coordinator ruling 15: unlisted work shows on the full profile only to
  // the owner and to an accepted connection. Being entitled to the full
  // profile at all is not enough on its own (an `open` profile is full to
  // every signed-in member). `ProfilesService.buildFullProfile` computes
  // `shouldIncludeUnlistedWork`; this mapper only obeys the flag.
  it('toFullProfile strips adultWork/sexWorker for a non-connected viewer, and keeps them for the owner or a connection', () => {
    const p = profile({
      discipline: ['healthcare', 'adultWork'],
      profession: ['nurse', 'sexWorker'],
    });

    // Default: neither owner nor flagged as a connection, the safe case.
    const strangerViewed = toFullProfile(p, emptyRels, 1);
    expect(strangerViewed.discipline).toEqual(['healthcare']);
    expect(strangerViewed.profession).toEqual(['nurse']);

    // isOwner true, shouldIncludeUnlistedWork left at its default: the owner
    // still gets their own unlisted work regardless of the connection flag,
    // since ProfilesService always resolves it to true for the owner.
    const owned = toFullProfile(p, emptyRels, 1, true, true);
    expect(owned.discipline).toEqual(['healthcare', 'adultWork']);
    expect(owned.profession).toEqual(['nurse', 'sexWorker']);

    // A non-owner viewer the caller has resolved as an accepted connection.
    const connectionViewed = toFullProfile(p, emptyRels, 1, false, true);
    expect(connectionViewed.discipline).toEqual(['healthcare', 'adultWork']);
    expect(connectionViewed.profession).toEqual(['nurse', 'sexWorker']);
  });

  it('gateAvatarUrl/gateLocation: owner always sees the real value, non-owner only when the toggle is on', () => {
    const p = profile({
      avatarUrl: 'https://x/a.png',
      location: 'Arroios',
      photoVisible: false,
      hoodVisible: false,
    });
    expect(gateAvatarUrl(p, true)).toBe('https://x/a.png');
    expect(gateAvatarUrl(p, false)).toBeNull();
    expect(gateLocation(p, true)).toBe('Arroios');
    expect(gateLocation(p, false)).toBeNull();

    const open = profile({
      avatarUrl: 'https://x/a.png',
      location: 'Arroios',
      photoVisible: true,
      hoodVisible: true,
    });
    expect(gateAvatarUrl(open, false)).toBe('https://x/a.png');
    expect(gateLocation(open, false)).toBe('Arroios');
  });

  it('toMemberCard shows a written tagline verbatim, untruncated', () => {
    const longTagline = 'a'.repeat(DIRECTORY_BLURB_MAX_CHARS + 40);
    const card = toMemberCard(
      profile({ tagline: longTagline, bio: LONG_BIO }),
      1,
    );
    expect(card.tagline).toBe(longTagline);
  });

  it('toMemberCard borrows the bio opening when the tagline is empty', () => {
    const card = toMemberCard(profile({ tagline: '', bio: LONG_BIO }), 1);
    expect(card.tagline).toBe(truncateAtWord(LONG_BIO));
    expect(card.tagline!.length).toBeLessThanOrEqual(
      DIRECTORY_BLURB_MAX_CHARS + 1,
    );
    expect(card.tagline!.endsWith('…')).toBe(true);
    // The card DTO must never carry the full bio to every browser.
    expect(card).not.toHaveProperty('bio');
  });

  it('toMemberCard shows a short bio whole, and treats blanks as empty', () => {
    expect(
      toMemberCard(profile({ tagline: null, bio: 'Cooks a lot' }), 1).tagline,
    ).toBe('Cooks a lot');
    expect(
      toMemberCard(profile({ tagline: '   ', bio: 'Cooks a lot' }), 1).tagline,
    ).toBe('Cooks a lot');
    expect(toMemberCard(profile({ tagline: '', bio: '' }), 1).tagline).toBe('');
  });

  // ENG-438: a `network`/`private` member's bio sits behind the limited card,
  // so its opening must not print on a card every member scrolls past.
  it.each([ProfileVisibility.Network, ProfileVisibility.Private])(
    'toMemberCard borrows no bio for a %s profile',
    (visibility) => {
      const hidden = profile({ visibility, tagline: '', bio: LONG_BIO });
      expect(toMemberCard(hidden, 1).tagline).toBe('');
      // The owner's own row matches what strangers see, as the editor's card
      // preview promises.
      expect(toMemberCard(hidden, 1, true).tagline).toBe('');
      // A written short bio is still theirs to show, on any tier.
      expect(
        toMemberCard(profile({ visibility, tagline: 'Cooks a lot' }), 1)
          .tagline,
      ).toBe('Cooks a lot');
    },
  );

  it('toProfileCard keeps the tagline raw when a member has only a bio', () => {
    // The trap: ProfileDTO inherits `tagline` from the card. The profile editor
    // seeds its short-bio input from this field, so serving the borrowed bio
    // here would let a member Save text they never wrote. Fallback is list-only.
    const card = toProfileCard(profile({ tagline: '', bio: LONG_BIO }), 1);
    expect(card.tagline).toBe('');
    expect(
      toProfileCard(profile({ tagline: null, bio: LONG_BIO }), 1).tagline,
    ).toBeNull();
  });

  it('toFullProfile and toLimitedProfile serve the raw tagline too', () => {
    const p = profile({ tagline: '', bio: LONG_BIO });
    expect(toFullProfile(p, emptyRels, 1).tagline).toBe('');
    expect(toLimitedProfile(p, 1).tagline).toBe('');
  });

  it('sortShapings orders film → book → song → moment', () => {
    const rows = [
      { kind: ShapingKind.Moment },
      { kind: ShapingKind.Film },
      { kind: ShapingKind.Song },
      { kind: ShapingKind.Book },
    ] as Shaping[];
    expect(sortShapings(rows).map((r) => r.kind)).toEqual([
      'film',
      'book',
      'song',
      'moment',
    ]);
  });
});
