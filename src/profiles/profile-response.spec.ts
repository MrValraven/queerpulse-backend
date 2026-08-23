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
    visibility: ProfileVisibility.Open,
    openTo: [{ kind: 'preset', id: 'collaborating' }] as OpenToEntry[],
    identities: ['Queer'],
    lookingFor: ['Community & friendship'],
    tags: ['React', 'TypeScript'],
    verified: true,
    joinedAt: new Date('2024-03-01T00:00:00.000Z'),
    ...overrides,
  }) as Profile;

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
      visibility: 'open',
      photoVisible: true,
      hoodVisible: true,
      vouchersVisible: true,
    });
  });

  it('toFullProfile serializes joinedAt as ISO and carries new scalars', () => {
    const dto = toFullProfile(profile(), emptyRels, 2);
    expect(dto.limited).toBe(false);
    expect(dto.verified).toBe(true);
    expect(dto.joinedAt).toBe('2024-03-01T00:00:00.000Z');
    expect(dto.now).toBe('building things');
    expect(dto.bio).toBe('a bio');
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
    // The boolean itself is still the true value for a non-owner too — only
    // the CONTENT is gated, never the toggle (a viewer needs to know whether
    // e.g. the vouchers endpoint is worth calling).
    expect(viewed.photoVisible).toBe(false);
    expect(viewed.hoodVisible).toBe(false);
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
      photoVisible: true,
      hoodVisible: true,
      vouchersVisible: true,
      verified: true,
      joinedAt: '2024-03-01T00:00:00.000Z',
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
    expect(viewed.photoVisible).toBe(false);

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
    // The toggle itself is still the true stored value on the card.
    expect(card.photoVisible).toBe(false);
    expect(card.hoodVisible).toBe(false);
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
