// Lives in `src/database` beside the other Postgres specs.
import { DataSource } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import {
  MEMBER_PERSONAS_SQL,
  OPTED_IN_COUNT_SQL,
  SUPPORTER_ARTIST_SQL,
  SUPPORTER_DELETE_SQL,
  SUPPORTER_PERSONAS_SQL,
  SUPPORTER_UPSERT_SQL,
  SUPPORTING_ROWS_SQL,
  TOP_SUPPORTERS_SQL,
} from '../studio/studio-supporters.service';
import { STUDIO_TOP_SUPPORTERS_SHOWN } from '../studio/studio-supporters';
import { STUDIO_ARTIST_PERSONA_KINDS } from '../studio/studio.constants';
import { SubprofileMember } from '../subprofiles/entities/subprofile-member.entity';
import {
  Subprofile,
  SubprofileKind,
  SubprofileStatus,
  SubprofileVisibility,
} from '../subprofiles/entities/subprofile.entity';
import { User, UserStatus } from '../users/entities/user.entity';

/**
 * The supporter queries on real Postgres. Skipped unless
 * `STUDIO_MIGRATIONS_DATABASE_URL` names a database whose name ends in
 * `_test` (it drops and synchronizes the schema from the entities).
 */
const DATABASE_URL = process.env.STUDIO_MIGRATIONS_DATABASE_URL;
const describeWithDatabase = DATABASE_URL ? describe : describe.skip;

const ARTIST_CREATOR = 'b1000000-0000-4000-8000-000000000001';
const CO_OWNER = 'b1000000-0000-4000-8000-000000000002';
const SUPPORTER_A = 'b1000000-0000-4000-8000-000000000003';
const SUPPORTER_B = 'b1000000-0000-4000-8000-000000000004';
// D holds the lower user id, so D ranks before C on a full tie.
const SUPPORTER_D = 'b1000000-0000-4000-8000-000000000005';
const SUPPORTER_C = 'b1000000-0000-4000-8000-000000000006';
const QUIET_SUPPORTER = 'b1000000-0000-4000-8000-000000000007';
const DEACTIVATED_SUPPORTER = 'b1000000-0000-4000-8000-000000000008';
const UNGRANTED_SUPPORTER = 'b1000000-0000-4000-8000-000000000009';
const OTHER_CREATOR = 'b1000000-0000-4000-8000-000000000010';
const PERSONA_CREATOR = 'b1000000-0000-4000-8000-000000000011';
const UNGRANTED_USERS = [UNGRANTED_SUPPORTER];
const GRANTED_USERS = [
  ARTIST_CREATOR,
  CO_OWNER,
  SUPPORTER_A,
  SUPPORTER_B,
  SUPPORTER_D,
  SUPPORTER_C,
  QUIET_SUPPORTER,
  DEACTIVATED_SUPPORTER,
  OTHER_CREATOR,
  PERSONA_CREATOR,
];

const MUSIC_PERSONA = 'b2000000-0000-4000-8000-000000000001';
const OTHER_PERSONA = 'b2000000-0000-4000-8000-000000000002';
const SHOWN_PERSONA = 'b2000000-0000-4000-8000-000000000003';
const DRAFT_PERSONA = 'b2000000-0000-4000-8000-000000000004';
const REMOVED_PERSONA = 'b2000000-0000-4000-8000-000000000005';

const MUSIC_IDENTITY = 'b3000000-0000-4000-8000-000000000001';
const SHOWN_IDENTITY = 'b3000000-0000-4000-8000-000000000002';

const RELEASE_ID = 'b4000000-0000-4000-8000-000000000001';
const OTHER_RELEASE_ID = 'b4000000-0000-4000-8000-000000000002';
const TRACK_1 = 'b5000000-0000-4000-8000-000000000001';
const TRACK_2 = 'b5000000-0000-4000-8000-000000000002';
const CREDITED_TRACK = 'b5000000-0000-4000-8000-000000000003';
const UNCREDITED_TRACK = 'b5000000-0000-4000-8000-000000000004';

const ARTIST_KINDS = [...STUDIO_ARTIST_PERSONA_KINDS];

// A: three listens (one own, two credited), B and C and D: two each, with
// C and D opted in at the same instant.
const RANKED = [SUPPORTER_A, SUPPORTER_B, SUPPORTER_D, SUPPORTER_C];
// The ranked supporters plus the one with no listen in the window.
const OPTED_IN_COUNT = 5;

interface TopSupporterRow {
  user_id: string;
  shown_as_subprofile_id: string | null;
}

interface SupporterTimesRow {
  shown_as_subprofile_id: string | null;
  created_at: Date;
  updated_at: Date;
}

function refuseUnlessTestDatabase(url: string): void {
  const databaseName = new URL(url).pathname.replace(/^\//, '');
  if (!databaseName.endsWith('_test')) {
    throw new Error(
      `Refusing to drop and synchronize "${databaseName}": the name must end in _test`,
    );
  }
}

describeWithDatabase('Studio supporters on real Postgres', () => {
  let dataSource: DataSource;

  const topRows = (
    limit = STUDIO_TOP_SUPPORTERS_SHOWN,
  ): Promise<TopSupporterRow[]> =>
    dataSource.query(TOP_SUPPORTERS_SQL, [MUSIC_PERSONA, limit]);

  const rankedUserIds = async (): Promise<string[]> =>
    (await topRows()).map((row) => row.user_id);

  const optedInCount = async (): Promise<number> => {
    const rows: { count: number }[] = await dataSource.query(
      OPTED_IN_COUNT_SQL,
      [MUSIC_PERSONA],
    );
    return rows.map((row) => row.count).reduce((sum, count) => sum + count, 0);
  };

  const artistRowsFor = (
    callerId: string,
    kinds: string[] = ARTIST_KINDS,
  ): Promise<Record<string, unknown>[]> =>
    dataSource.query(SUPPORTER_ARTIST_SQL, [MUSIC_PERSONA, callerId, kinds]);

  const withRows = async (
    insertStatements: [string, unknown[]][],
    cleanupStatements: [string, unknown[]][],
    check: () => Promise<void>,
  ): Promise<void> => {
    try {
      for (const [statement, parameters] of insertStatements) {
        await dataSource.query(statement, parameters);
      }
      await check();
    } finally {
      for (const [statement, parameters] of cleanupStatements) {
        await dataSource.query(statement, parameters);
      }
    }
  };

  const withBlocks = (
    blockerBlockedPairs: [string, string][],
    check: () => Promise<void>,
  ): Promise<void> =>
    withRows(
      blockerBlockedPairs.map(([blockerId, blockedId]): [string, unknown[]] => [
        `INSERT INTO "blocks" ("blocker_id", "blocked_id") VALUES ($1, $2)`,
        [blockerId, blockedId],
      ]),
      [[`DELETE FROM "blocks"`, []]],
      check,
    );

  const withIdentityBlock = (
    blockerUserId: string,
    identityId: string | null,
    blockedSubprofileId: string | null,
    check: () => Promise<void>,
  ): Promise<void> =>
    withRows(
      [
        [
          `INSERT INTO "identity_blocks" ("blocker_user_id", "identity_id", "blocked_subprofile_id")
           VALUES ($1, $2, $3)`,
          [blockerUserId, identityId, blockedSubprofileId],
        ],
      ],
      [[`DELETE FROM "identity_blocks"`, []]],
      check,
    );

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
      [...GRANTED_USERS, ...UNGRANTED_USERS].map((userId) => ({
        id: userId,
        googleId: `google-${userId}`,
        email: `${userId}@example.test`,
        status:
          userId === DEACTIVATED_SUPPORTER
            ? UserStatus.Deactivated
            : UserStatus.Active,
      })),
    );
    await dataSource.query(
      `INSERT INTO "studio_access_grants" ("user_id") SELECT unnest($1::uuid[])`,
      [GRANTED_USERS],
    );
    await dataSource.getRepository(Subprofile).insert([
      {
        id: MUSIC_PERSONA,
        userId: ARTIST_CREATOR,
        slug: 'harbour-lights',
        handle: 'harbour-lights',
        displayName: 'Harbour Lights',
        kind: SubprofileKind.Musician,
        status: SubprofileStatus.Published,
        visibility: SubprofileVisibility.Open,
      },
      {
        id: OTHER_PERSONA,
        userId: OTHER_CREATOR,
        slug: 'tram-28',
        handle: 'tram-28',
        displayName: 'Tram 28',
        kind: SubprofileKind.Dj,
        status: SubprofileStatus.Published,
        visibility: SubprofileVisibility.Open,
      },
      {
        id: SHOWN_PERSONA,
        userId: PERSONA_CREATOR,
        slug: 'paper-lanterns',
        handle: 'paper-lanterns',
        displayName: 'Paper Lanterns',
        kind: SubprofileKind.Writer,
        status: SubprofileStatus.Published,
        visibility: SubprofileVisibility.Open,
      },
      {
        id: DRAFT_PERSONA,
        userId: SUPPORTER_B,
        slug: 'night-ferry',
        displayName: 'Night Ferry',
        kind: SubprofileKind.Developer,
        status: SubprofileStatus.Draft,
        visibility: SubprofileVisibility.Open,
      },
      {
        id: REMOVED_PERSONA,
        userId: SUPPORTER_B,
        slug: 'amber-fields',
        handle: 'amber-fields',
        displayName: 'Amber Fields',
        kind: SubprofileKind.Developer,
        status: SubprofileStatus.Published,
        visibility: SubprofileVisibility.Open,
        removedAt: new Date('2026-10-01T08:00:00.000Z'),
      },
    ]);
    // The draft and removed personas have no member row: their creator
    // column alone makes SUPPORTER_B a member.
    await dataSource.getRepository(SubprofileMember).insert([
      { subprofileId: MUSIC_PERSONA, userId: ARTIST_CREATOR },
      { subprofileId: MUSIC_PERSONA, userId: CO_OWNER },
      { subprofileId: OTHER_PERSONA, userId: OTHER_CREATOR },
      { subprofileId: SHOWN_PERSONA, userId: PERSONA_CREATOR },
      { subprofileId: SHOWN_PERSONA, userId: SUPPORTER_B },
    ]);
    await dataSource.query(
      `INSERT INTO "identities" ("id", "kind", "subprofile_id")
       VALUES ($1, 'subprofile', $2), ($3, 'subprofile', $4)`,
      [MUSIC_IDENTITY, MUSIC_PERSONA, SHOWN_IDENTITY, SHOWN_PERSONA],
    );
    await dataSource.query(
      `INSERT INTO "studio_releases" ("id", "subprofile_id", "title", "type", "status", "published_at")
       VALUES ($1, $2, 'Low tide', 'album', 'published', now()),
              ($3, $4, 'Tram at dawn', 'mix', 'published', now())`,
      [RELEASE_ID, MUSIC_PERSONA, OTHER_RELEASE_ID, OTHER_PERSONA],
    );
    await dataSource.query(
      `INSERT INTO "studio_tracks" ("id", "release_id", "position", "title", "audio_key", "duration_seconds")
       VALUES ($1, $5, 1, 'Harbour', 'studio-audio/a/b.mp3', 200),
              ($2, $5, 2, 'Lights', 'studio-audio/a/c.mp3', 200),
              ($3, $6, 1, 'Featuring Harbour', 'studio-audio/a/d.mp3', 200),
              ($4, $6, 2, 'Tram solo', 'studio-audio/a/e.mp3', 200)`,
      [
        TRACK_1,
        TRACK_2,
        CREDITED_TRACK,
        UNCREDITED_TRACK,
        RELEASE_ID,
        OTHER_RELEASE_ID,
      ],
    );
    await dataSource.query(
      `INSERT INTO "studio_persona_credits"
         ("track_id", "subprofile_id", "role", "status", "requested_by_subprofile_id")
       VALUES ($1, $2, 'producer', 'accepted', $3)`,
      [CREDITED_TRACK, MUSIC_PERSONA, OTHER_PERSONA],
    );
    const listens: [string, string, number][] = [
      [SUPPORTER_A, TRACK_1, 1],
      [SUPPORTER_A, CREDITED_TRACK, 2],
      [SUPPORTER_A, CREDITED_TRACK, 3],
      [SUPPORTER_B, TRACK_2, 1],
      [SUPPORTER_B, TRACK_2, 2],
      [SUPPORTER_C, TRACK_1, 1],
      [SUPPORTER_C, TRACK_2, 4],
      [SUPPORTER_D, TRACK_1, 1],
      [SUPPORTER_D, TRACK_1, 5],
      // Another persona's track with no credit: never counts for the artist.
      [SUPPORTER_D, UNCREDITED_TRACK, 1],
      [SUPPORTER_D, UNCREDITED_TRACK, 2],
      [SUPPORTER_D, UNCREDITED_TRACK, 3],
      // Outside the window, by one day.
      [QUIET_SUPPORTER, TRACK_1, 29],
      [QUIET_SUPPORTER, TRACK_1, 29],
      [QUIET_SUPPORTER, TRACK_1, 40],
      [QUIET_SUPPORTER, TRACK_1, 40],
      ...[1, 2, 3, 4, 5].map((daysAgo): [string, string, number] => [
        DEACTIVATED_SUPPORTER,
        TRACK_1,
        daysAgo,
      ]),
      ...[1, 2, 3, 4, 5].map((daysAgo): [string, string, number] => [
        UNGRANTED_SUPPORTER,
        TRACK_1,
        daysAgo,
      ]),
    ];
    for (const [userId, trackId, daysAgo] of listens) {
      await dataSource.query(
        `INSERT INTO "studio_listens" ("user_id", "track_id", "played_at")
         VALUES ($1, $2, now() - make_interval(days => $3::int))`,
        [userId, trackId, daysAgo],
      );
    }
    const supporters: [string, string, string | null, string][] = [
      [SUPPORTER_A, MUSIC_PERSONA, null, '2026-10-01T08:00:00.000Z'],
      [SUPPORTER_B, MUSIC_PERSONA, SHOWN_PERSONA, '2026-10-02T08:00:00.000Z'],
      [SUPPORTER_C, MUSIC_PERSONA, null, '2026-10-03T08:00:00.000Z'],
      [SUPPORTER_D, MUSIC_PERSONA, null, '2026-10-03T08:00:00.000Z'],
      [QUIET_SUPPORTER, MUSIC_PERSONA, null, '2026-09-01T08:00:00.000Z'],
      [DEACTIVATED_SUPPORTER, MUSIC_PERSONA, null, '2026-09-02T08:00:00.000Z'],
      [UNGRANTED_SUPPORTER, MUSIC_PERSONA, null, '2026-09-03T08:00:00.000Z'],
      [SUPPORTER_A, OTHER_PERSONA, null, '2026-10-05T08:00:00.000Z'],
    ];
    for (const [userId, artistId, shownAsId, createdAt] of supporters) {
      await dataSource.query(
        `INSERT INTO "studio_supporters"
           ("user_id", "subprofile_id", "shown_as_subprofile_id", "created_at", "updated_at")
         VALUES ($1, $2, $3, $4::timestamptz, $4::timestamptz)`,
        [userId, artistId, shownAsId, createdAt],
      );
    }
  }, 120000);

  afterAll(async () => {
    await dataSource?.destroy();
  });

  it('ranks opted-in listeners by listens in the last 28 days, then by opt-in date, then by user id', async () => {
    expect(await topRows()).toEqual([
      { user_id: SUPPORTER_A, shown_as_subprofile_id: null },
      { user_id: SUPPORTER_B, shown_as_subprofile_id: SHOWN_PERSONA },
      { user_id: SUPPORTER_D, shown_as_subprofile_id: null },
      { user_id: SUPPORTER_C, shown_as_subprofile_id: null },
    ]);
    expect((await topRows(2)).map((row) => row.user_id)).toEqual([
      SUPPORTER_A,
      SUPPORTER_B,
    ]);
    expect(await optedInCount()).toBe(OPTED_IN_COUNT);
  });

  it('counts listens on credited tracks toward the credited persona', async () => {
    // With the credit pending, A keeps one listen and drops to last.
    await withRows(
      [
        [
          `UPDATE "studio_persona_credits" SET "status" = 'pending' WHERE "track_id" = $1`,
          [CREDITED_TRACK],
        ],
      ],
      [
        [
          `UPDATE "studio_persona_credits" SET "status" = 'accepted' WHERE "track_id" = $1`,
          [CREDITED_TRACK],
        ],
      ],
      async () => {
        expect(await rankedUserIds()).toEqual([
          SUPPORTER_B,
          SUPPORTER_D,
          SUPPORTER_C,
          SUPPORTER_A,
        ]);
      },
    );
    expect(await rankedUserIds()).toEqual(RANKED);
  });

  it('leaves out a supporter with no listen in 28 days and keeps them in the opted-in count', async () => {
    expect(await rankedUserIds()).not.toContain(QUIET_SUPPORTER);
    expect(await optedInCount()).toBe(OPTED_IN_COUNT);

    await withRows(
      [
        [
          `INSERT INTO "studio_listens" ("user_id", "track_id", "played_at")
           VALUES ($1, $2, now() - interval '1 day')`,
          [QUIET_SUPPORTER, TRACK_1],
        ],
      ],
      [
        [
          `DELETE FROM "studio_listens" WHERE "user_id" = $1 AND "played_at" > now() - interval '2 days'`,
          [QUIET_SUPPORTER],
        ],
      ],
      async () => {
        expect(await rankedUserIds()).toEqual([...RANKED, QUIET_SUPPORTER]);
        expect(await optedInCount()).toBe(OPTED_IN_COUNT);
      },
    );
  });

  it('leaves out a supporter blocked either way with a co-owner', async () => {
    await withBlocks([[CO_OWNER, SUPPORTER_A]], async () => {
      expect(await rankedUserIds()).toEqual([
        SUPPORTER_B,
        SUPPORTER_D,
        SUPPORTER_C,
      ]);
      expect(await optedInCount()).toBe(OPTED_IN_COUNT - 1);
    });
    await withBlocks([[SUPPORTER_B, CO_OWNER]], async () => {
      expect(await rankedUserIds()).toEqual([
        SUPPORTER_A,
        SUPPORTER_D,
        SUPPORTER_C,
      ]);
      expect(await optedInCount()).toBe(OPTED_IN_COUNT - 1);
    });
    expect(await rankedUserIds()).toEqual(RANKED);
  });

  it('leaves out a supporter whose chosen persona a co-owner identity-blocked', async () => {
    const withoutSupporterB = [SUPPORTER_A, SUPPORTER_D, SUPPORTER_C];
    // A direct block names the persona's identity row.
    await withIdentityBlock(CO_OWNER, SHOWN_IDENTITY, null, async () => {
      expect(await rankedUserIds()).toEqual(withoutSupporterB);
      expect(await optedInCount()).toBe(OPTED_IN_COUNT - 1);
    });
    // A carried block names the persona itself.
    await withIdentityBlock(CO_OWNER, null, SHOWN_PERSONA, async () => {
      expect(await rankedUserIds()).toEqual(withoutSupporterB);
      expect(await optedInCount()).toBe(OPTED_IN_COUNT - 1);
    });
    // A block by someone outside the artist changes nothing.
    await withIdentityBlock(OTHER_CREATOR, SHOWN_IDENTITY, null, async () => {
      expect(await rankedUserIds()).toEqual(RANKED);
    });
  });

  it('leaves out a deactivated supporter and one without a grant', async () => {
    expect(await rankedUserIds()).toEqual(RANKED);
    expect(await optedInCount()).toBe(OPTED_IN_COUNT);

    // Each would lead the ranking with five listens once eligible.
    await withRows(
      [
        [
          `UPDATE "users" SET "status" = 'active' WHERE "id" = $1`,
          [DEACTIVATED_SUPPORTER],
        ],
      ],
      [
        [
          `UPDATE "users" SET "status" = 'deactivated' WHERE "id" = $1`,
          [DEACTIVATED_SUPPORTER],
        ],
      ],
      async () => {
        expect(await rankedUserIds()).toEqual([
          DEACTIVATED_SUPPORTER,
          ...RANKED,
        ]);
      },
    );
    await withRows(
      [
        [
          `INSERT INTO "studio_access_grants" ("user_id") VALUES ($1)`,
          [UNGRANTED_SUPPORTER],
        ],
      ],
      [
        [
          `DELETE FROM "studio_access_grants" WHERE "user_id" = $1`,
          [UNGRANTED_SUPPORTER],
        ],
      ],
      async () => {
        expect(await rankedUserIds()).toEqual([UNGRANTED_SUPPORTER, ...RANKED]);
      },
    );
    expect(await rankedUserIds()).toEqual(RANKED);
  });

  it('leaves out a supporter who became a co-owner', async () => {
    await withRows(
      [
        [
          `INSERT INTO "subprofile_members" ("subprofile_id", "user_id") VALUES ($1, $2)`,
          [MUSIC_PERSONA, SUPPORTER_A],
        ],
      ],
      [
        [
          `DELETE FROM "subprofile_members" WHERE "subprofile_id" = $1 AND "user_id" = $2`,
          [MUSIC_PERSONA, SUPPORTER_A],
        ],
      ],
      async () => {
        expect(await rankedUserIds()).toEqual([
          SUPPORTER_B,
          SUPPORTER_D,
          SUPPORTER_C,
        ]);
        expect(await optedInCount()).toBe(OPTED_IN_COUNT - 1);
      },
    );
    expect(await rankedUserIds()).toEqual(RANKED);
  });

  it('leaves out a supporter whose chosen persona no longer counts them as a member', async () => {
    await withRows(
      [
        [
          `DELETE FROM "subprofile_members" WHERE "subprofile_id" = $1 AND "user_id" = $2`,
          [SHOWN_PERSONA, SUPPORTER_B],
        ],
      ],
      [
        [
          `INSERT INTO "subprofile_members" ("subprofile_id", "user_id") VALUES ($1, $2)`,
          [SHOWN_PERSONA, SUPPORTER_B],
        ],
      ],
      async () => {
        expect(await rankedUserIds()).toEqual([
          SUPPORTER_A,
          SUPPORTER_D,
          SUPPORTER_C,
        ]);
        expect(await optedInCount()).toBe(OPTED_IN_COUNT - 1);
      },
    );
    expect(await rankedUserIds()).toEqual(RANKED);
  });

  it('leaves out a supporter whose chosen persona is moderation-hidden or removed until they pick again', async () => {
    const withoutSupporterB = [SUPPORTER_A, SUPPORTER_D, SUPPORTER_C];
    await withRows(
      [
        [
          `INSERT INTO "content_moderation" ("subject_type", "subject_id", "hidden_at")
           VALUES ('subprofile', $1, now())`,
          [SHOWN_PERSONA],
        ],
      ],
      [
        [
          `DELETE FROM "content_moderation" WHERE "subject_id" = $1`,
          [SHOWN_PERSONA],
        ],
      ],
      async () => {
        expect(await rankedUserIds()).toEqual(withoutSupporterB);
        expect(await optedInCount()).toBe(OPTED_IN_COUNT - 1);
      },
    );
    expect(await rankedUserIds()).toEqual(RANKED);
    expect(await optedInCount()).toBe(OPTED_IN_COUNT);

    await withRows(
      [
        [
          `UPDATE "subprofiles" SET "removed_at" = now() WHERE "id" = $1`,
          [SHOWN_PERSONA],
        ],
      ],
      [
        [
          `UPDATE "subprofiles" SET "removed_at" = NULL WHERE "id" = $1`,
          [SHOWN_PERSONA],
        ],
      ],
      async () => {
        expect(await rankedUserIds()).toEqual(withoutSupporterB);
        expect(await optedInCount()).toBe(OPTED_IN_COUNT - 1);
        // Picking the account brings the supporter back.
        await withRows(
          [
            [
              `UPDATE "studio_supporters" SET "shown_as_subprofile_id" = NULL
                WHERE "user_id" = $1 AND "subprofile_id" = $2`,
              [SUPPORTER_B, MUSIC_PERSONA],
            ],
          ],
          [
            [
              `UPDATE "studio_supporters" SET "shown_as_subprofile_id" = $3
                WHERE "user_id" = $1 AND "subprofile_id" = $2`,
              [SUPPORTER_B, MUSIC_PERSONA, SHOWN_PERSONA],
            ],
          ],
          async () => {
            expect(await rankedUserIds()).toEqual(RANKED);
          },
        );
      },
    );
    expect(await rankedUserIds()).toEqual(RANKED);
  });

  it('keeps a supporter whose chosen persona is only private or a draft', async () => {
    for (const [column, value] of [
      ['visibility', 'private'],
      ['status', 'draft'],
    ] as const) {
      const restoredValue = column === 'visibility' ? 'open' : 'published';
      await withRows(
        [
          [
            `UPDATE "subprofiles" SET "${column}" = $2 WHERE "id" = $1`,
            [SHOWN_PERSONA, value],
          ],
        ],
        [
          [
            `UPDATE "subprofiles" SET "${column}" = $2 WHERE "id" = $1`,
            [SHOWN_PERSONA, restoredValue],
          ],
        ],
        async () => {
          expect(await topRows()).toEqual([
            { user_id: SUPPORTER_A, shown_as_subprofile_id: null },
            { user_id: SUPPORTER_B, shown_as_subprofile_id: SHOWN_PERSONA },
            { user_id: SUPPORTER_D, shown_as_subprofile_id: null },
            { user_id: SUPPORTER_C, shown_as_subprofile_id: null },
          ]);
          expect(await optedInCount()).toBe(OPTED_IN_COUNT);
          const chosenRows: { is_linkable: boolean }[] = await dataSource.query(
            SUPPORTER_PERSONAS_SQL,
            [[SHOWN_PERSONA]],
          );
          expect(chosenRows.map((row) => row.is_linkable)).toEqual([false]);
        },
      );
    }
  });

  it('answers the artist row with is_own_persona for the creator and a co-owner', async () => {
    expect(await artistRowsFor(SUPPORTER_C)).toEqual([
      {
        artist_id: MUSIC_PERSONA,
        artist_handle: 'harbour-lights',
        artist_display_name: 'Harbour Lights',
        artist_kind: 'musician',
        artist_avatar_url: null,
        is_own_persona: false,
      },
    ]);
    expect(
      (await artistRowsFor(CO_OWNER)).map((row) => row.is_own_persona),
    ).toEqual([true]);
    expect(
      (await artistRowsFor(ARTIST_CREATOR)).map((row) => row.is_own_persona),
    ).toEqual([true]);
  });

  it('refuses an artist of another kind, a hidden one and one behind a block with a co-owner', async () => {
    expect(await artistRowsFor(SUPPORTER_C, ['dj'])).toEqual([]);
    await withRows(
      [
        [
          `UPDATE "subprofiles" SET "status" = 'draft' WHERE "id" = $1`,
          [MUSIC_PERSONA],
        ],
      ],
      [
        [
          `UPDATE "subprofiles" SET "status" = 'published' WHERE "id" = $1`,
          [MUSIC_PERSONA],
        ],
      ],
      async () => {
        expect(await artistRowsFor(SUPPORTER_C)).toEqual([]);
      },
    );
    await withBlocks([[CO_OWNER, SUPPORTER_C]], async () => {
      expect(await artistRowsFor(SUPPORTER_C)).toEqual([]);
    });
    expect(await artistRowsFor(SUPPORTER_C)).toHaveLength(1);
  });

  it('refuses an artist the caller identity-blocked', async () => {
    await withIdentityBlock(SUPPORTER_C, MUSIC_IDENTITY, null, async () => {
      expect(await artistRowsFor(SUPPORTER_C)).toEqual([]);
    });
    await withIdentityBlock(SUPPORTER_C, null, MUSIC_PERSONA, async () => {
      expect(await artistRowsFor(SUPPORTER_C)).toEqual([]);
    });
    // The supporting list applies the same artist rule.
    await withIdentityBlock(SUPPORTER_A, MUSIC_IDENTITY, null, async () => {
      const rows: { artist_id: string }[] = await dataSource.query(
        SUPPORTING_ROWS_SQL,
        [SUPPORTER_A, ARTIST_KINDS],
      );
      expect(rows.map((row) => row.artist_id)).toEqual([OTHER_PERSONA]);
    });
    expect(await artistRowsFor(SUPPORTER_C)).toHaveLength(1);
  });

  it('lists the caller opt-ins newest first and leaves out an artist behind a block', async () => {
    const supportingOf = async (
      kinds: string[] = ARTIST_KINDS,
    ): Promise<[string, string | null, Date][]> => {
      const rows: {
        artist_id: string;
        shown_as_subprofile_id: string | null;
        created_at: Date;
      }[] = await dataSource.query(SUPPORTING_ROWS_SQL, [SUPPORTER_A, kinds]);
      return rows.map((row): [string, string | null, Date] => [
        row.artist_id,
        row.shown_as_subprofile_id,
        row.created_at,
      ]);
    };

    expect(await supportingOf()).toEqual([
      [OTHER_PERSONA, null, new Date('2026-10-05T08:00:00.000Z')],
      [MUSIC_PERSONA, null, new Date('2026-10-01T08:00:00.000Z')],
    ]);
    expect((await supportingOf(['musician'])).map((row) => row[0])).toEqual([
      MUSIC_PERSONA,
    ]);
    await withBlocks([[OTHER_CREATOR, SUPPORTER_A]], async () => {
      expect((await supportingOf()).map((row) => row[0])).toEqual([
        MUSIC_PERSONA,
      ]);
    });
  });

  it('upserts keeping created_at and moves updated_at on a change only', async () => {
    const pastInstant = new Date('2026-01-01T00:00:00.000Z');
    const supporterTimes = async (): Promise<SupporterTimesRow[]> =>
      dataSource.query(
        `SELECT "shown_as_subprofile_id", "created_at", "updated_at"
           FROM "studio_supporters"
          WHERE "user_id" = $1 AND "subprofile_id" = $2`,
        [SUPPORTER_C, OTHER_PERSONA],
      );

    try {
      await dataSource.query(SUPPORTER_UPSERT_SQL, [
        SUPPORTER_C,
        OTHER_PERSONA,
        null,
      ]);
      expect(
        (await supporterTimes()).map((row) => row.shown_as_subprofile_id),
      ).toEqual([null]);
      await dataSource.query(
        `UPDATE "studio_supporters" SET "created_at" = $3, "updated_at" = $3
          WHERE "user_id" = $1 AND "subprofile_id" = $2`,
        [SUPPORTER_C, OTHER_PERSONA, pastInstant],
      );

      // The same identity again: nothing moves.
      await dataSource.query(SUPPORTER_UPSERT_SQL, [
        SUPPORTER_C,
        OTHER_PERSONA,
        null,
      ]);
      expect(await supporterTimes()).toEqual([
        {
          shown_as_subprofile_id: null,
          created_at: pastInstant,
          updated_at: pastInstant,
        },
      ]);

      // A new identity moves updated_at only.
      await dataSource.query(SUPPORTER_UPSERT_SQL, [
        SUPPORTER_C,
        OTHER_PERSONA,
        SHOWN_PERSONA,
      ]);
      const changedRows = await supporterTimes();
      expect(
        changedRows.map((row) => [
          row.shown_as_subprofile_id,
          row.created_at,
          row.updated_at > pastInstant,
        ]),
      ).toEqual([[SHOWN_PERSONA, pastInstant, true]]);

      // The same persona again keeps that updated_at.
      await dataSource.query(SUPPORTER_UPSERT_SQL, [
        SUPPORTER_C,
        OTHER_PERSONA,
        SHOWN_PERSONA,
      ]);
      expect(await supporterTimes()).toEqual(changedRows);
    } finally {
      await dataSource.query(SUPPORTER_DELETE_SQL, [
        SUPPORTER_C,
        OTHER_PERSONA,
      ]);
    }
    expect(await supporterTimes()).toEqual([]);
  });

  it('lists member personas without removed ones and without the artist', async () => {
    const draftRow = {
      id: DRAFT_PERSONA,
      handle: null,
      display_name: 'Night Ferry',
      kind: 'developer',
      avatar_url: null,
      is_linkable: false,
    };
    const shownRow = {
      id: SHOWN_PERSONA,
      handle: 'paper-lanterns',
      display_name: 'Paper Lanterns',
      kind: 'writer',
      avatar_url: null,
      is_linkable: true,
    };
    const memberPersonas = (
      callerId: string,
      leftOutId: string,
      onlyId: string | null,
    ): Promise<unknown[]> =>
      dataSource.query(MEMBER_PERSONAS_SQL, [callerId, leftOutId, onlyId]);

    // The creator arm (draft) and the member-row arm (shown), by name.
    expect(await memberPersonas(SUPPORTER_B, MUSIC_PERSONA, null)).toEqual([
      draftRow,
      shownRow,
    ]);
    expect(await memberPersonas(SUPPORTER_B, SHOWN_PERSONA, null)).toEqual([
      draftRow,
    ]);
    expect(
      await memberPersonas(SUPPORTER_B, MUSIC_PERSONA, SHOWN_PERSONA),
    ).toEqual([shownRow]);
    expect(
      await memberPersonas(SUPPORTER_B, MUSIC_PERSONA, REMOVED_PERSONA),
    ).toEqual([]);
    expect(
      await memberPersonas(SUPPORTER_A, MUSIC_PERSONA, SHOWN_PERSONA),
    ).toEqual([]);

    // The listener's own state and supporting list read a chosen persona
    // back even once removed, unlinked. The owner ranking leaves that
    // supporter out (the removed and moderation-hidden case below).
    const chosenRows: { id: string; is_linkable: boolean }[] =
      await dataSource.query(SUPPORTER_PERSONAS_SQL, [
        [SHOWN_PERSONA, REMOVED_PERSONA],
      ]);
    expect(chosenRows.map((row) => [row.id, row.is_linkable])).toEqual([
      [SHOWN_PERSONA, true],
      [REMOVED_PERSONA, false],
    ]);
  });
});
