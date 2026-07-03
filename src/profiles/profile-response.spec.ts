import { Profile, ProfileVisibility } from '../users/entities/profile.entity';
import { Activity, ActivityKind } from './entities/activity.entity';
import { BoardKind, BoardPost } from './entities/board-post.entity';
import { Shaping, ShapingKind } from './entities/shaping.entity';
import { Skill } from './entities/skill.entity';
import { SocialLink } from './entities/social-link.entity';
import { WorkItem } from './entities/work-item.entity';
import {
  ProfileRelations,
  sortShapings,
  toFullProfile,
  toLimitedProfile,
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
    openTo: ['Collaboration'],
    tags: ['React', 'TypeScript'],
    verified: true,
    joinedAt: new Date('2024-03-01T00:00:00.000Z'),
    ...overrides,
  }) as Profile;

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
