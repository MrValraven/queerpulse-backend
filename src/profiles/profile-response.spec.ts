import {
  resetImageUrlBaseForTesting,
  setImageUrlBase,
} from '../common/image-url';
import { Profile, ProfileVisibility } from '../users/entities/profile.entity';
import { DIRECTORY_BLURB_MAX_CHARS, truncateAtWord } from './directory-blurb';
import { Activity, ActivityKind } from './entities/activity.entity';
import { BoardKind, BoardPost } from './entities/board-post.entity';
import { Shaping, ShapingKind } from './entities/shaping.entity';
import { Skill } from './entities/skill.entity';
import { SocialLink } from './entities/social-link.entity';
import { WorkItem } from './entities/work-item.entity';
import { OpenToEntry } from './open-to';
import {
  ProfileRelations,
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
    tagline: 'Fullstack Developer',
    bio: 'a bio',
    location: 'Arroios',
    now: 'building things',
    avatarUrl: 'https://x/a.png',
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

  it('toProfileCard returns exactly the 9 card fields', () => {
    const card = toProfileCard(profile(), 2);
    expect(card).toEqual({
      slug: 'tiago',
      firstName: 'Tiago',
      lastName: 'Costa',
      pronouns: 'he/they',
      tagline: 'Fullstack Developer',
      avatarUrl: 'https://x/a.png',
      tags: ['React', 'TypeScript'],
      vouchCount: 2,
      visibility: 'open',
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
        },
      ] as unknown as WorkItem[],
      board: [
        {
          kind: BoardKind.Offering,
          title: 'Help',
          slug: 'web-dev-help',
          position: 0,
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
    });
    expect(dto.board[0]).toEqual({
      kind: 'offering',
      title: 'Help',
      slug: 'web-dev-help',
    });
    expect(dto.skills[0]).toEqual({ name: 'Web dev', meta: 'React' });
    expect(dto.groups[0]).toEqual({ name: 'Queer Devs', role: 'Member' });
    expect(dto.activity[0]).toEqual({
      kind: 'event',
      title: "RSVP'd",
      sub: 'Anjos',
      to: '/gatherings/x',
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
      tagline: 'Fullstack Developer',
      avatarUrl: 'https://x/a.png',
      tags: ['React', 'TypeScript'],
      vouchCount: 5,
      visibility: 'private',
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
      limited: true,
    });
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
