// Lives in `src/database` beside the other Postgres specs.
import { HttpException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import { StudioArtistSearchService } from '../music-events/studio-artist-search.service';
import {
  STUDIO_ARTIST_SEARCH_COUNT_SQL,
  STUDIO_ARTIST_SEARCH_SQL,
} from '../music-events/studio-artist-sql';
import { STUDIO_ARTIST_PERSONA_KINDS } from '../studio/studio.constants';
import {
  Subprofile,
  SubprofileKind,
  SubprofileLinkVisibility,
  SubprofileStatus,
  SubprofileVisibility,
} from '../subprofiles/entities/subprofile.entity';
import { SubprofileMember } from '../subprofiles/entities/subprofile-member.entity';
import { SUBPROFILE_MODERATION_SUBJECT_TYPE } from '../subprofiles/subprofile-takedown';
import { Profile } from '../users/entities/profile.entity';
import { User, UserStatus } from '../users/entities/user.entity';

/**
 * The Studio artist rule behind the house lineup picker and the book check,
 * on real Postgres. Skipped unless `MUSIC_EVENTS_DATABASE_URL` names a
 * database whose name ends in `_test` (it drops and synchronizes the
 * schema):
 *
 *   MUSIC_EVENTS_DATABASE_URL=postgres://postgres@127.0.0.1:55450/music_test \
 *     npx jest src/database/studio-artist-search.postgres.spec.ts
 *
 * The cast, read by STAFF:
 * - ARTIST_A created a linked, open, published `dj` persona (Nightjar), and
 *   also an unlinked one (Secret Moth) that must stay hidden.
 * - MEMBER_B has only an unlinked `musician` persona (Velvet Echo).
 * - MEMBER_C co-owns Nightjar (a `subprofile_members` row) and created none.
 * - MEMBER_D created a linked persona under a `content_moderation` takedown.
 * - ARTIST_E created a linked persona and is blocked by STAFF.
 * - ARTIST_F created a linked `dj` persona (Fabi Spins) and blocks STAFF.
 * OTHER_STAFF has no block with anyone.
 */
const DATABASE_URL = process.env.MUSIC_EVENTS_DATABASE_URL;
const describeWithDatabase = DATABASE_URL ? describe : describe.skip;

const STAFF = '97000000-0000-4000-8000-000000000001';
const OTHER_STAFF = '97000000-0000-4000-8000-000000000002';
const ARTIST_A = '97000000-0000-4000-8000-000000000003';
const MEMBER_B = '97000000-0000-4000-8000-000000000004';
const MEMBER_C = '97000000-0000-4000-8000-000000000005';
const MEMBER_D = '97000000-0000-4000-8000-000000000006';
const ARTIST_E = '97000000-0000-4000-8000-000000000007';
const ARTIST_F = '97000000-0000-4000-8000-000000000008';

const NIGHTJAR = '98000000-0000-4000-8000-000000000001';
const SECRET_MOTH = '98000000-0000-4000-8000-000000000002';
const VELVET_ECHO = '98000000-0000-4000-8000-000000000003';
const TAKEN_DOWN_PERSONA = '98000000-0000-4000-8000-000000000004';
const BLOCKED_PERSONA = '98000000-0000-4000-8000-000000000005';
const BLOCKING_PERSONA = '98000000-0000-4000-8000-000000000006';

/** [user id, slug, first name, last name] */
const EVERY_MEMBER: [string, string, string, string][] = [
  [STAFF, 'sam-staff', 'Sam', 'Staff'],
  [OTHER_STAFF, 'olga-staff', 'Olga', 'Staff'],
  [ARTIST_A, 'ana-alves', 'Ana', 'Alves'],
  [MEMBER_B, 'bia-borges', 'Bia', 'Borges'],
  [MEMBER_C, 'caio-cruz', 'Caio', 'Cruz'],
  [MEMBER_D, 'dora-dias', 'Dora', 'Dias'],
  [ARTIST_E, 'eva-esteves', 'Eva', 'Esteves'],
  [ARTIST_F, 'fabi-faria', 'Fabi', 'Faria'],
];

/** [persona id, creator, handle, display name, kind, link visibility] */
const EVERY_PERSONA: [
  string,
  string,
  string,
  string,
  SubprofileKind,
  SubprofileLinkVisibility,
][] = [
  [
    NIGHTJAR,
    ARTIST_A,
    'nightjar',
    'Nightjar',
    SubprofileKind.Dj,
    SubprofileLinkVisibility.Linked,
  ],
  [
    SECRET_MOTH,
    ARTIST_A,
    'secret-moth',
    'Secret Moth',
    SubprofileKind.Dj,
    SubprofileLinkVisibility.Unlinked,
  ],
  [
    VELVET_ECHO,
    MEMBER_B,
    'velvet-echo',
    'Velvet Echo',
    SubprofileKind.Musician,
    SubprofileLinkVisibility.Unlinked,
  ],
  [
    TAKEN_DOWN_PERSONA,
    MEMBER_D,
    'dora-decks',
    'Dora Decks',
    SubprofileKind.Dj,
    SubprofileLinkVisibility.Linked,
  ],
  [
    BLOCKED_PERSONA,
    ARTIST_E,
    'eva-live',
    'Eva Live',
    SubprofileKind.Dj,
    SubprofileLinkVisibility.Linked,
  ],
  [
    BLOCKING_PERSONA,
    ARTIST_F,
    'fabi-spins',
    'Fabi Spins',
    SubprofileKind.Dj,
    SubprofileLinkVisibility.Linked,
  ],
];

function refuseUnlessTestDatabase(url: string): void {
  const databaseName = new URL(url).pathname.replace(/^\//, '');
  if (!databaseName.endsWith('_test')) {
    throw new Error(
      `Refusing to drop and synchronize "${databaseName}": the name must end in _test`,
    );
  }
}

async function expectNotStudioArtist(promise: Promise<unknown>): Promise<void> {
  const error: unknown = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(HttpException);
  const exception = error as HttpException;
  expect(exception.getStatus()).toBe(403);
  expect(exception.getResponse()).toMatchObject({
    code: 'music_event_performer_not_studio_artist',
  });
}

describeWithDatabase('StudioArtistSearchService on real Postgres', () => {
  let dataSource: DataSource;
  let service: StudioArtistSearchService;

  const slugsFound = async (
    staffUserId: string,
    query: string | undefined,
  ): Promise<string[]> => {
    const page = await service.search(staffUserId, query, 1);
    return page.items.map((item) => item.slug);
  };

  beforeAll(async () => {
    refuseUnlessTestDatabase(DATABASE_URL!);
    dataSource = new DataSource({
      type: 'postgres',
      url: DATABASE_URL,
      entities: [`${__dirname}/../**/*.entity.ts`],
      namingStrategy: new SnakeNamingStrategy(),
      dropSchema: true,
      synchronize: true,
    });
    await dataSource.initialize();

    await dataSource.getRepository(User).insert(
      EVERY_MEMBER.map(([userId]) => ({
        id: userId,
        googleId: `google-${userId}`,
        email: `${userId}@example.test`,
        status: UserStatus.Active,
      })),
    );
    await dataSource.getRepository(Profile).insert(
      EVERY_MEMBER.map(([userId, slug, firstName, lastName]) => ({
        userId,
        slug,
        firstName,
        lastName,
      })),
    );
    await dataSource.getRepository(Subprofile).insert(
      EVERY_PERSONA.map(
        ([
          personaId,
          creatorId,
          handle,
          displayName,
          kind,
          linkVisibility,
        ]) => ({
          id: personaId,
          userId: creatorId,
          slug: handle,
          handle,
          displayName,
          kind,
          linkVisibility,
          status: SubprofileStatus.Published,
          visibility: SubprofileVisibility.Open,
        }),
      ),
    );
    await dataSource.getRepository(SubprofileMember).insert([
      { subprofileId: NIGHTJAR, userId: ARTIST_A },
      { subprofileId: NIGHTJAR, userId: MEMBER_C },
    ]);
    await dataSource.query(
      `INSERT INTO "content_moderation" ("subject_type", "subject_id", "hidden_at")
       VALUES ($1, $2, now())`,
      [SUBPROFILE_MODERATION_SUBJECT_TYPE, TAKEN_DOWN_PERSONA],
    );
    await dataSource.query(
      `INSERT INTO "blocks" ("blocker_id", "blocked_id") VALUES ($1, $2), ($3, $4)`,
      [STAFF, ARTIST_E, ARTIST_F, STAFF],
    );

    service = new StudioArtistSearchService(
      dataSource,
      dataSource.getRepository(Profile),
    );
  }, 120000);

  afterAll(async () => {
    await dataSource?.destroy();
  });

  it('finds a member by a linked persona name and never by an unlinked one', async () => {
    expect(await slugsFound(STAFF, undefined)).toEqual(['ana-alves']);
    expect(await slugsFound(STAFF, 'Nightjár')).toEqual(['ana-alves']);
    expect(await slugsFound(STAFF, 'ana-al')).toEqual(['ana-alves']);
    expect(await slugsFound(STAFF, 'secret moth')).toEqual([]);
    expect(await slugsFound(STAFF, 'velvet')).toEqual([]);
    expect(await slugsFound(STAFF, 'bia')).toEqual([]);

    const page = await service.search(STAFF, undefined, 1);
    expect(page.items.map((item) => item.artistPersonas)).toEqual([
      [
        {
          subprofileId: NIGHTJAR,
          handle: 'nightjar',
          displayName: 'Nightjar',
          kind: 'dj',
        },
      ],
    ]);
  });

  it('refuses a member whose only artist persona is unlinked', async () => {
    await expect(
      service.assertBookable(STAFF, ARTIST_A),
    ).resolves.toBeUndefined();
    await expectNotStudioArtist(service.assertBookable(STAFF, MEMBER_B));
  });

  it('refuses a co-owner who created no artist persona', async () => {
    await expectNotStudioArtist(service.assertBookable(STAFF, MEMBER_C));
    expect(await slugsFound(STAFF, 'nightjar')).toEqual(['ana-alves']);
  });

  it('refuses a member whose persona is taken down', async () => {
    await expectNotStudioArtist(service.assertBookable(STAFF, MEMBER_D));
    expect(await slugsFound(OTHER_STAFF, 'dora')).toEqual([]);
  });

  it('checks the block against the staff member', async () => {
    await expectNotStudioArtist(service.assertBookable(STAFF, ARTIST_E));
    await expect(
      service.assertBookable(OTHER_STAFF, ARTIST_E),
    ).resolves.toBeUndefined();
    expect(await slugsFound(STAFF, 'eva')).toEqual([]);
    expect(await slugsFound(OTHER_STAFF, 'eva')).toEqual(['eva-esteves']);
  });

  it('checks a block the performer placed on the staff member', async () => {
    await expectNotStudioArtist(service.assertBookable(STAFF, ARTIST_F));
    await expect(
      service.assertBookable(OTHER_STAFF, ARTIST_F),
    ).resolves.toBeUndefined();
    expect(await slugsFound(STAFF, undefined)).not.toContain('fabi-faria');
    expect(await slugsFound(STAFF, 'fabi')).toEqual([]);
    expect(await slugsFound(OTHER_STAFF, 'fabi')).toEqual(['fabi-faria']);
  });

  it('never matches an unlinked persona by its handle', async () => {
    expect(await slugsFound(STAFF, 'secret-moth')).toEqual([]);
    expect(await slugsFound(OTHER_STAFF, 'velvet-echo')).toEqual([]);
  });

  it('counts the same rows the page lists', async () => {
    const artistKinds = [...STUDIO_ARTIST_PERSONA_KINDS];
    for (const [staffUserId, likeTerm] of [
      [OTHER_STAFF, null],
      [STAFF, null],
      [OTHER_STAFF, '%live%'],
      [OTHER_STAFF, '%moth%'],
    ] as const) {
      const idRows: { user_id: string }[] = await dataSource.query(
        STUDIO_ARTIST_SEARCH_SQL,
        [likeTerm, staffUserId, artistKinds, 20, 0],
      );
      const countRows: { total: number }[] = await dataSource.query(
        STUDIO_ARTIST_SEARCH_COUNT_SQL,
        [likeTerm, staffUserId, artistKinds],
      );
      expect(countRows.map((row) => row.total)).toEqual([idRows.length]);
    }

    const page = await service.search(OTHER_STAFF, undefined, 1);
    expect({
      slugs: page.items.map((item) => item.slug),
      total: page.total,
    }).toEqual({
      slugs: ['ana-alves', 'eva-esteves', 'fabi-faria'],
      total: 3,
    });
  });
});
