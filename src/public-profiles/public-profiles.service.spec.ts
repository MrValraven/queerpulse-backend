import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { SelectQueryBuilder } from 'typeorm';
import { MemberPreferences } from '../preferences/entities/member-preferences.entity';
import { SocialLink } from '../profiles/entities/social-link.entity';
import { WorkItem } from '../profiles/entities/work-item.entity';
import { Profile, ProfileVisibility } from '../users/entities/profile.entity';
import { UserStatus } from '../users/entities/user.entity';
import { PublicProfilesService } from './public-profiles.service';

/**
 * A row as the database sees it: the profile, plus the two things that live on
 * other tables and decide whether it may be published at all.
 * `publicEnabled: null` models the common case of a member who has never opened
 * the settings page and therefore has NO `member_preferences` row — the case an
 * INNER JOIN must reject.
 */
interface Fixture {
  profile: Profile;
  status: UserStatus;
  publicEnabled: boolean | null;
}

/**
 * A semantic stand-in for the query builder. Rather than letting the test hand
 * back a canned `getOne()` result — which would pass just as happily against a
 * service with every gate deleted — this records the predicates the service
 * actually registers and then EVALUATES them against the fixtures. A removed
 * `status = 'active'` join stops filtering here, so the deactivated-member test
 * fails, which is the point.
 */
class FakeQueryBuilder {
  readonly joins: { alias: string; condition: string; params: Params }[] = [];
  readonly wheres: { condition: string; params: Params }[] = [];

  constructor(private readonly rows: Fixture[]) {}

  innerJoin(
    _target: unknown,
    alias: string,
    condition: string,
    params?: Params,
  ) {
    this.joins.push({ alias, condition, params: params ?? {} });
    return this;
  }

  where(condition: string, params?: Params) {
    this.wheres.push({ condition, params: params ?? {} });
    return this;
  }

  andWhere(condition: string, params?: Params) {
    return this.where(condition, params);
  }

  /** True when the service asked for `users.status = 'active'`. */
  get gatesOnActiveStatus(): boolean {
    return this.joins.some(
      (j) =>
        /u\.status\s*=\s*:active/.test(j.condition) &&
        j.params.active === UserStatus.Active,
    );
  }

  /** True when the service asked for `public_profile_enabled = true`. */
  get gatesOnPublicFlag(): boolean {
    return this.joins.some((j) =>
      /public_profile_enabled\s*=\s*true/.test(j.condition),
    );
  }

  /** True when the service asked for `profiles.visibility = 'open'`. */
  get gatesOnOpenVisibility(): boolean {
    return this.wheres.some(
      (w) =>
        /p\.visibility\s*=\s*:open/.test(w.condition) &&
        w.params.open === ProfileVisibility.Open,
    );
  }

  private get requestedSlug(): unknown {
    return this.wheres.find((w) => /p\.slug\s*=\s*:slug/.test(w.condition))
      ?.params.slug;
  }

  getOne(): Promise<Profile | null> {
    const match = this.rows.find((row) => {
      if (row.profile.slug !== this.requestedSlug) return false;
      if (this.gatesOnActiveStatus && row.status !== UserStatus.Active) {
        return false;
      }
      if (this.gatesOnPublicFlag && row.publicEnabled !== true) return false;
      if (
        this.gatesOnOpenVisibility &&
        row.profile.visibility !== ProfileVisibility.Open
      ) {
        return false;
      }
      return true;
    });
    return Promise.resolve(match?.profile ?? null);
  }
}

type Params = Record<string, unknown>;

describe('PublicProfilesService', () => {
  let service: PublicProfilesService;
  let builder: FakeQueryBuilder;
  let fixtures: Fixture[];
  let socialRows: SocialLink[];
  let workRows: WorkItem[];

  // Every field on the entity is populated, including the ones that must never
  // be published — a fixture with `identities: []` would let a leak pass
  // unnoticed because the leaked value looked empty.
  const profile = (overrides: Partial<Profile> = {}): Profile =>
    Object.assign(new Profile(), {
      userId: 'u1',
      slug: 'ada',
      firstName: 'Ada',
      lastName: 'Lovelace',
      pronouns: 'she/her',
      tagline: 'Building queer software',
      bio: 'Long-form bio.',
      location: 'Lisbon',
      avatarUrl: 'https://cdn.example/a.png',
      visibility: ProfileVisibility.Open,
      openTo: [{ kind: 'preset', id: 'mentoring' }],
      identities: ['Trans', 'Disabled or chronically ill'],
      discoverableIdentities: ['Trans'],
      lookingFor: ['Collaborators'],
      tags: ['design'],
      verified: true,
      now: 'Shipping a thing',
      joinedAt: new Date('2026-01-01T00:00:00.000Z'),
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      ...overrides,
    });

  const published = (overrides: Partial<Profile> = {}): Fixture => ({
    profile: profile(overrides),
    status: UserStatus.Active,
    publicEnabled: true,
  });

  beforeEach(async () => {
    fixtures = [published()];
    socialRows = [
      Object.assign(new SocialLink(), {
        id: 's1',
        userId: 'u1',
        platform: 'mastodon',
        urlOrHandle: '@ada@example.social',
        position: 0,
      }),
    ];
    workRows = [
      Object.assign(new WorkItem(), {
        id: 'w1',
        userId: 'u1',
        category: 'Talk',
        title: 'On Notation',
        year: '2026',
        imageUrl: null,
        position: 0,
      }),
    ];

    const profiles = {
      createQueryBuilder: jest.fn(() => {
        builder = new FakeQueryBuilder(fixtures);
        return builder as unknown as SelectQueryBuilder<Profile>;
      }),
    };
    const socialLinks = { find: jest.fn(() => Promise.resolve(socialRows)) };
    const workItems = { find: jest.fn(() => Promise.resolve(workRows)) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PublicProfilesService,
        { provide: getRepositoryToken(Profile), useValue: profiles },
        { provide: getRepositoryToken(SocialLink), useValue: socialLinks },
        { provide: getRepositoryToken(WorkItem), useValue: workItems },
        { provide: getRepositoryToken(MemberPreferences), useValue: {} },
      ],
    }).compile();

    service = module.get(PublicProfilesService);
  });

  describe('a published, active member', () => {
    it('returns exactly the allowlisted fields and nothing else', async () => {
      const result = await service.getBySlug('ada');

      // Deep equality on the WHOLE object, not field-by-field assertions: this
      // is what fails the moment an extra key appears in the projection.
      expect(result).toEqual({
        slug: 'ada',
        displayName: 'Ada Lovelace',
        pronouns: 'she/her',
        tagline: 'Building queer software',
        avatarUrl: 'https://cdn.example/a.png',
        bio: 'Long-form bio.',
        socials: [{ platform: 'mastodon', urlOrHandle: '@ada@example.social' }],
        work: [
          {
            category: 'Talk',
            title: 'On Notation',
            year: '2026',
            imageUrl: null,
          },
        ],
      });
    });

    // The named-key check, kept separate from the deep-equal above so a failure
    // says *which* private field escaped rather than dumping a whole diff.
    it('publishes none of the forbidden fields', async () => {
      const result = await service.getBySlug('ada');

      const forbidden = [
        'email',
        'identities',
        'discoverableIdentities',
        'lookingFor',
        'openTo',
        'outAtWork',
        'transSupport',
        'safeOnly',
        'publicProfileEnabled',
        'vouchCount',
        'connectionCount',
        'groups',
        'related',
        'status',
        'role',
        'verified',
        'visibility',
        'userId',
        'location',
        'now',
        'tags',
        'joinedAt',
        'createdAt',
        'updatedAt',
        'user',
        'limited',
      ];
      for (const key of forbidden) {
        expect(result).not.toHaveProperty(key);
      }
    });

    it('never serialises the raw first/last name as separate fields', async () => {
      const result = await service.getBySlug('ada');

      expect(result).not.toHaveProperty('firstName');
      expect(result).not.toHaveProperty('lastName');
      expect(result.displayName).toBe('Ada Lovelace');
    });

    it('orders socials and work by the member’s chosen position', async () => {
      await service.getBySlug('ada');

      expect(
        (
          service as unknown as {
            socialLinks: { find: jest.Mock };
          }
        ).socialLinks.find,
      ).toHaveBeenCalledWith({
        where: { userId: 'u1' },
        order: { position: 'ASC' },
      });
    });
  });

  describe('the gate', () => {
    const expectNotFound = async (slug: string) => {
      await expect(service.getBySlug(slug)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    };

    it('404s when the member has not enabled the public profile', async () => {
      fixtures = [{ ...published(), publicEnabled: false }];

      await expectNotFound('ada');
    });

    // Fail closed: no preferences row must never read as "published".
    it('404s when the member has no preferences row at all', async () => {
      fixtures = [{ ...published(), publicEnabled: null }];

      await expectNotFound('ada');
    });

    // Deactivation and the 30-day erasure grace period both land on
    // `deactivated`; the UI promises the member is already hidden.
    it('404s for a deactivated member even with the flag on', async () => {
      fixtures = [{ ...published(), status: UserStatus.Deactivated }];

      await expectNotFound('ada');
    });

    it('404s for a suspended member even with the flag on', async () => {
      fixtures = [{ ...published(), status: UserStatus.Suspended }];

      await expectNotFound('ada');
    });

    it('404s for an unknown slug', async () => {
      await expectNotFound('nobody-here');
    });

    // The composition rule: the flag intersects visibility, never overrides it.
    it('404s when visibility is network, even with the flag on', async () => {
      fixtures = [published({ visibility: ProfileVisibility.Network })];

      await expectNotFound('ada');
    });

    it('404s when visibility is private, even with the flag on', async () => {
      fixtures = [published({ visibility: ProfileVisibility.Private })];

      await expectNotFound('ada');
    });

    it('applies all three gates in the query itself', async () => {
      await service.getBySlug('ada');

      expect(builder.gatesOnActiveStatus).toBe(true);
      expect(builder.gatesOnPublicFlag).toBe(true);
      expect(builder.gatesOnOpenVisibility).toBe(true);
    });
  });

  describe('indistinguishability', () => {
    // A 403, or any wording that differs by reason, would confirm the member
    // exists — the exact fact an unpublished member is withholding.
    it('gives an identical 404 body for unknown, unpublished and deactivated', async () => {
      const bodies: unknown[] = [];

      const capture = async (slug: string) => {
        try {
          await service.getBySlug(slug);
          throw new Error('expected a NotFoundException');
        } catch (err) {
          expect(err).toBeInstanceOf(NotFoundException);
          bodies.push((err as NotFoundException).getResponse());
        }
      };

      await capture('no-such-slug');

      fixtures = [{ ...published(), publicEnabled: false }];
      await capture('ada');

      fixtures = [{ ...published(), status: UserStatus.Deactivated }];
      await capture('ada');

      fixtures = [published({ visibility: ProfileVisibility.Private })];
      await capture('ada');

      expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
    });

    // An unpublished member's related rows must not even be read — no query, no
    // timing difference, nothing in a slow-query log.
    it('does not read socials or work for an unpublished member', async () => {
      fixtures = [{ ...published(), publicEnabled: false }];
      const repos = service as unknown as {
        socialLinks: { find: jest.Mock };
        workItems: { find: jest.Mock };
      };

      await expect(service.getBySlug('ada')).rejects.toBeInstanceOf(
        NotFoundException,
      );

      expect(repos.socialLinks.find).not.toHaveBeenCalled();
      expect(repos.workItems.find).not.toHaveBeenCalled();
    });
  });
});
