// Lives in `src/database` beside the other Postgres specs.
import { DataSource } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import { RELEASE_WALL_SQL } from '../studio/studio-purchase-wall.service';
import { STUDIO_PURCHASE_LIMITS } from '../studio/studio-purchase-rules';
import { SubprofileMember } from '../subprofiles/entities/subprofile-member.entity';
import {
  Subprofile,
  SubprofileKind,
  SubprofileStatus,
  SubprofileVisibility,
} from '../subprofiles/entities/subprofile.entity';
import { SUBPROFILE_MODERATION_SUBJECT_TYPE } from '../subprofiles/subprofile-takedown';
import { User, UserStatus } from '../users/entities/user.entity';

/**
 * The supporter wall query (contract section 5) on real Postgres. Skipped
 * unless `STUDIO_MIGRATIONS_DATABASE_URL` names a database whose name ends in
 * `_test` (it drops and synchronizes the schema from the entities). Each test
 * inserts its own confirmed purchases with explicit decision times and
 * deletes them afterwards.
 */
const DATABASE_URL = process.env.STUDIO_MIGRATIONS_DATABASE_URL;
const describeWithDatabase = DATABASE_URL ? describe : describe.skip;

const ARTIST_CREATOR = 'd1000000-0000-4000-8000-000000000001';
const CO_OWNER = 'd1000000-0000-4000-8000-000000000002';
const BUYER_A = 'd1000000-0000-4000-8000-000000000003';
// B created the shown persona and C co-owns it.
const BUYER_B = 'd1000000-0000-4000-8000-000000000004';
const BUYER_C = 'd1000000-0000-4000-8000-000000000005';
const BUYER_D = 'd1000000-0000-4000-8000-000000000006';
const BUYER_E = 'd1000000-0000-4000-8000-000000000007';
const BUYER_F = 'd1000000-0000-4000-8000-000000000008';
const VIEWER = 'd1000000-0000-4000-8000-000000000009';

/** One buyer per entry of the paging test. */
const PAGE_BUYERS = Array.from(
  { length: 26 },
  (_value, index) =>
    `d1100000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
);

const GRANTED_USERS = [
  ARTIST_CREATOR,
  CO_OWNER,
  BUYER_A,
  BUYER_B,
  BUYER_C,
  BUYER_D,
  BUYER_E,
  BUYER_F,
  VIEWER,
  ...PAGE_BUYERS,
];

const MUSIC_PERSONA = 'd2000000-0000-4000-8000-000000000001';
const SHOWN_PERSONA = 'd2000000-0000-4000-8000-000000000002';
const SHORT_LIVED_PERSONA = 'd2000000-0000-4000-8000-000000000003';

const SHOWN_IDENTITY = 'd3000000-0000-4000-8000-000000000001';

const ALBUM_ID = 'd4000000-0000-4000-8000-000000000001';
const OTHER_ALBUM_ID = 'd4000000-0000-4000-8000-000000000002';
const TRACK_1 = 'd5000000-0000-4000-8000-000000000001';
const TRACK_2 = 'd5000000-0000-4000-8000-000000000002';
const OTHER_TRACK = 'd5000000-0000-4000-8000-000000000003';

const REFERENCE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const BASE_DECIDED_AT = Date.parse('2026-10-20T10:00:00.000Z');

/** The wall reads one row past the page. */
const WALL_LIMIT = STUDIO_PURCHASE_LIMITS.wallPerPage + 1;

type PurchaseStatus =
  'pending' | 'confirmed' | 'declined' | 'cancelled' | 'expired';

interface PurchaseFixture {
  id: string;
  buyerUserId: string;
  releaseId?: string;
  trackId?: string;
  status?: PurchaseStatus;
  isOnWall?: boolean;
  shownAsSubprofileId?: string;
  /** Minutes after the base time; ignored for a pending purchase. */
  decidedMinute: number;
}

interface WallRow {
  id: string;
  buyer_user_id: string;
  is_shown_as_persona: boolean;
  shown_as_subprofile_id: string | null;
  decided_at: Date;
}

function purchaseId(index: number): string {
  return `d6000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function decidedAtOf(minute: number): Date {
  return new Date(BASE_DECIDED_AT + minute * 60_000);
}

/** Descending order of two ids, compared the way Postgres orders uuids. */
function compareDescending(leftId: string, rightId: string): number {
  if (leftId === rightId) {
    return 0;
  }
  return leftId < rightId ? 1 : -1;
}

function refuseUnlessTestDatabase(url: string): void {
  const databaseName = new URL(url).pathname.replace(/^\//, '');
  if (!databaseName.endsWith('_test')) {
    throw new Error(
      `Refusing to drop and synchronize "${databaseName}": the name must end in _test`,
    );
  }
}

describeWithDatabase('Studio supporter wall on real Postgres', () => {
  let dataSource: DataSource;
  let referenceCounter = 0;

  /** A valid reference code that no other row of this run holds. */
  const nextReferenceCode = (): string => {
    referenceCounter += 1;
    const first = REFERENCE_ALPHABET[Math.floor(referenceCounter / 31) % 31];
    const second = REFERENCE_ALPHABET[referenceCounter % 31];
    return `WA${first}${second}ZZ`;
  };

  const wallRows = (
    viewerId: string = VIEWER,
    cursorPosition: [Date | null, string | null] = [null, null],
    limit: number = WALL_LIMIT,
  ): Promise<WallRow[]> =>
    dataSource.query(RELEASE_WALL_SQL, [
      ALBUM_ID,
      viewerId,
      ...cursorPosition,
      limit,
    ]);

  const wallIds = async (viewerId: string = VIEWER): Promise<string[]> =>
    (await wallRows(viewerId)).map((row) => row.id);

  const insertPurchase = async (purchase: PurchaseFixture): Promise<void> => {
    const status = purchase.status ?? 'confirmed';
    const isTrack = purchase.trackId !== undefined;
    await dataSource.query(
      `INSERT INTO "studio_purchases"
         ("id", "buyer_user_id", "subprofile_id", "artist_name", "item_kind",
          "release_id", "track_id", "item_title", "amount_cents", "reference_code",
          "status", "decline_reason", "is_on_wall", "is_shown_as_persona",
          "shown_as_subprofile_id", "decided_at")
       VALUES ($1, $2, $3, 'Harbour Lights', $4, $5, $6, 'Low tide', 500, $7,
               $8, $9, $10, $11, $12, $13::timestamptz)`,
      [
        purchase.id,
        purchase.buyerUserId,
        MUSIC_PERSONA,
        isTrack ? 'track' : 'release',
        isTrack ? null : (purchase.releaseId ?? ALBUM_ID),
        purchase.trackId ?? null,
        nextReferenceCode(),
        status,
        status === 'declined' ? 'payment_not_found' : null,
        purchase.isOnWall ?? true,
        purchase.shownAsSubprofileId !== undefined,
        purchase.shownAsSubprofileId ?? null,
        status === 'pending' ? null : decidedAtOf(purchase.decidedMinute),
      ],
    );
  };

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

  const withPurchases = async (
    purchases: PurchaseFixture[],
    check: () => Promise<void>,
  ): Promise<void> => {
    try {
      for (const purchase of purchases) {
        await insertPurchase(purchase);
      }
      await check();
    } finally {
      await dataSource.query(`DELETE FROM "studio_purchases"`);
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
      GRANTED_USERS.map((userId) => ({
        id: userId,
        googleId: `google-${userId}`,
        email: `${userId}@example.test`,
        status: UserStatus.Active,
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
        id: SHOWN_PERSONA,
        userId: BUYER_B,
        slug: 'paper-lanterns',
        handle: 'paper-lanterns',
        displayName: 'Paper Lanterns',
        kind: SubprofileKind.Writer,
        status: SubprofileStatus.Published,
        visibility: SubprofileVisibility.Open,
      },
    ]);
    await dataSource.getRepository(SubprofileMember).insert([
      { subprofileId: MUSIC_PERSONA, userId: ARTIST_CREATOR },
      { subprofileId: MUSIC_PERSONA, userId: CO_OWNER },
      { subprofileId: SHOWN_PERSONA, userId: BUYER_B },
      { subprofileId: SHOWN_PERSONA, userId: BUYER_C },
    ]);
    await dataSource.query(
      `INSERT INTO "identities" ("id", "kind", "subprofile_id")
       VALUES ($1, 'subprofile', $2)`,
      [SHOWN_IDENTITY, SHOWN_PERSONA],
    );
    await dataSource.query(
      `INSERT INTO "studio_releases" ("id", "subprofile_id", "title", "type", "status", "published_at")
       VALUES ($1, $3, 'Low tide', 'album', 'published', now()),
              ($2, $3, 'High water', 'album', 'published', now())`,
      [ALBUM_ID, OTHER_ALBUM_ID, MUSIC_PERSONA],
    );
    await dataSource.query(
      `INSERT INTO "studio_tracks" ("id", "release_id", "position", "title", "audio_key", "duration_seconds")
       VALUES ($1, $4, 1, 'Harbour', 'studio-audio/a/b.mp3', 200),
              ($2, $4, 2, 'Lights', 'studio-audio/a/c.mp3', 200),
              ($3, $5, 1, 'Flood', 'studio-audio/a/d.mp3', 200)`,
      [TRACK_1, TRACK_2, OTHER_TRACK, ALBUM_ID, OTHER_ALBUM_ID],
    );
  }, 120000);

  afterAll(async () => {
    await dataSource?.destroy();
  });

  it('shows opted-in confirmed buyers of the release and of its tracks, newest first', async () => {
    await withPurchases(
      [
        { id: purchaseId(1), buyerUserId: BUYER_A, decidedMinute: 1 },
        {
          id: purchaseId(2),
          buyerUserId: BUYER_D,
          trackId: TRACK_1,
          decidedMinute: 3,
        },
        {
          id: purchaseId(3),
          buyerUserId: BUYER_E,
          trackId: TRACK_2,
          decidedMinute: 2,
        },
        // Another release and its track stay off this wall.
        {
          id: purchaseId(4),
          buyerUserId: BUYER_F,
          releaseId: OTHER_ALBUM_ID,
          decidedMinute: 4,
        },
        {
          id: purchaseId(5),
          buyerUserId: BUYER_F,
          trackId: OTHER_TRACK,
          decidedMinute: 5,
        },
      ],
      async () => {
        expect(
          (await wallRows()).map((row) => [
            row.id,
            row.buyer_user_id,
            row.is_shown_as_persona,
            row.shown_as_subprofile_id,
            row.decided_at.toISOString(),
          ]),
        ).toEqual([
          [purchaseId(2), BUYER_D, false, null, decidedAtOf(3).toISOString()],
          [purchaseId(3), BUYER_E, false, null, decidedAtOf(2).toISOString()],
          [purchaseId(1), BUYER_A, false, null, decidedAtOf(1).toISOString()],
        ]);
      },
    );
  });

  it('leaves out pending, declined and off-the-wall purchases', async () => {
    await withPurchases(
      [
        {
          id: purchaseId(1),
          buyerUserId: BUYER_A,
          status: 'pending',
          decidedMinute: 0,
        },
        {
          id: purchaseId(2),
          buyerUserId: BUYER_D,
          status: 'declined',
          decidedMinute: 2,
        },
        {
          id: purchaseId(3),
          buyerUserId: BUYER_E,
          isOnWall: false,
          decidedMinute: 3,
        },
        {
          id: purchaseId(4),
          buyerUserId: BUYER_A,
          trackId: TRACK_1,
          status: 'cancelled',
          decidedMinute: 4,
        },
        {
          id: purchaseId(5),
          buyerUserId: BUYER_D,
          trackId: TRACK_2,
          status: 'expired',
          decidedMinute: 5,
        },
        { id: purchaseId(6), buyerUserId: BUYER_F, decidedMinute: 1 },
      ],
      async () => {
        expect(await wallIds()).toEqual([purchaseId(6)]);
      },
    );
  });

  it('shows a buyer of the album and two tracks once, at the newest purchase', async () => {
    await withPurchases(
      [
        { id: purchaseId(1), buyerUserId: BUYER_A, decidedMinute: 1 },
        {
          id: purchaseId(2),
          buyerUserId: BUYER_A,
          trackId: TRACK_1,
          decidedMinute: 3,
        },
        {
          id: purchaseId(3),
          buyerUserId: BUYER_A,
          trackId: TRACK_2,
          decidedMinute: 2,
        },
        { id: purchaseId(4), buyerUserId: BUYER_D, decidedMinute: 4 },
      ],
      async () => {
        expect(await wallIds()).toEqual([purchaseId(4), purchaseId(2)]);
      },
    );
  });

  it('shows two co-owners who chose the same persona once', async () => {
    await withPurchases(
      [
        { id: purchaseId(1), buyerUserId: BUYER_A, decidedMinute: 1 },
        {
          id: purchaseId(2),
          buyerUserId: BUYER_B,
          shownAsSubprofileId: SHOWN_PERSONA,
          decidedMinute: 2,
        },
        {
          id: purchaseId(3),
          buyerUserId: BUYER_C,
          trackId: TRACK_1,
          shownAsSubprofileId: SHOWN_PERSONA,
          decidedMinute: 3,
        },
      ],
      async () => {
        expect(
          (await wallRows()).map((row) => [
            row.id,
            row.is_shown_as_persona,
            row.shown_as_subprofile_id,
          ]),
        ).toEqual([
          [purchaseId(3), true, SHOWN_PERSONA],
          [purchaseId(1), false, null],
        ]);
      },
    );
  });

  it('hides a buyer the viewer blocks and one who blocks the viewer', async () => {
    await withPurchases(
      [
        { id: purchaseId(1), buyerUserId: BUYER_A, decidedMinute: 1 },
        { id: purchaseId(2), buyerUserId: BUYER_D, decidedMinute: 2 },
        { id: purchaseId(3), buyerUserId: BUYER_E, decidedMinute: 3 },
      ],
      async () => {
        await withBlocks(
          [
            [VIEWER, BUYER_A],
            [BUYER_D, VIEWER],
          ],
          async () => {
            expect(await wallIds()).toEqual([purchaseId(3)]);
            // A block involving another member leaves this viewer's wall whole.
            expect(await wallIds(BUYER_F)).toEqual([
              purchaseId(3),
              purchaseId(2),
              purchaseId(1),
            ]);
          },
        );
        expect(await wallIds()).toEqual([
          purchaseId(3),
          purchaseId(2),
          purchaseId(1),
        ]);
      },
    );
  });

  it('hides a deactivated buyer and one whose grant was revoked, and shows them again when the grant returns', async () => {
    await withPurchases(
      [
        { id: purchaseId(1), buyerUserId: BUYER_A, decidedMinute: 1 },
        { id: purchaseId(2), buyerUserId: BUYER_D, decidedMinute: 2 },
      ],
      async () => {
        await withRows(
          [
            [
              `UPDATE "users" SET "status" = 'deactivated' WHERE "id" = $1`,
              [BUYER_A],
            ],
            [
              `DELETE FROM "studio_access_grants" WHERE "user_id" = $1`,
              [BUYER_D],
            ],
          ],
          [
            [
              `UPDATE "users" SET "status" = 'active' WHERE "id" = $1`,
              [BUYER_A],
            ],
            [
              `INSERT INTO "studio_access_grants" ("user_id") VALUES ($1)`,
              [BUYER_D],
            ],
          ],
          async () => {
            expect(await wallIds()).toEqual([]);
          },
        );
        expect(await wallIds()).toEqual([purchaseId(2), purchaseId(1)]);
      },
    );
  });

  it('hides a buyer who became a member of the release persona', async () => {
    await withPurchases(
      [{ id: purchaseId(1), buyerUserId: BUYER_A, decidedMinute: 1 }],
      async () => {
        await withRows(
          [
            [
              `INSERT INTO "subprofile_members" ("subprofile_id", "user_id") VALUES ($1, $2)`,
              [MUSIC_PERSONA, BUYER_A],
            ],
          ],
          [
            [
              `DELETE FROM "subprofile_members" WHERE "subprofile_id" = $1 AND "user_id" = $2`,
              [MUSIC_PERSONA, BUYER_A],
            ],
          ],
          async () => {
            expect(await wallIds()).toEqual([]);
          },
        );
        expect(await wallIds()).toEqual([purchaseId(1)]);
      },
    );
  });

  it('hides a chosen persona that was deleted and never shows the account in its place', async () => {
    await dataSource.getRepository(Subprofile).insert({
      id: SHORT_LIVED_PERSONA,
      userId: BUYER_E,
      slug: 'short-lived',
      handle: 'short-lived',
      displayName: 'Short Lived',
      kind: SubprofileKind.Developer,
      status: SubprofileStatus.Published,
      visibility: SubprofileVisibility.Open,
    });
    try {
      await withPurchases(
        [
          {
            id: purchaseId(1),
            buyerUserId: BUYER_E,
            shownAsSubprofileId: SHORT_LIVED_PERSONA,
            decidedMinute: 1,
          },
        ],
        async () => {
          expect(await wallIds()).toEqual([purchaseId(1)]);

          await dataSource.query(`DELETE FROM "subprofiles" WHERE "id" = $1`, [
            SHORT_LIVED_PERSONA,
          ]);

          const storedRows: {
            is_shown_as_persona: boolean;
            shown_as_subprofile_id: string | null;
          }[] = await dataSource.query(
            `SELECT "is_shown_as_persona", "shown_as_subprofile_id"
               FROM "studio_purchases" WHERE "id" = $1`,
            [purchaseId(1)],
          );
          expect(
            storedRows.map((row) => [
              row.is_shown_as_persona,
              row.shown_as_subprofile_id,
            ]),
          ).toEqual([[true, null]]);
          expect(await wallIds()).toEqual([]);
        },
      );
    } finally {
      await dataSource.query(`DELETE FROM "subprofiles" WHERE "id" = $1`, [
        SHORT_LIVED_PERSONA,
      ]);
    }
  });

  it('hides a chosen persona the viewer identity-blocked, the buyer left, or a moderator hid', async () => {
    const withPersonaEntry = [purchaseId(2), purchaseId(1)];
    const withoutPersonaEntry = [purchaseId(1)];
    await withPurchases(
      [
        { id: purchaseId(1), buyerUserId: BUYER_A, decidedMinute: 1 },
        {
          id: purchaseId(2),
          buyerUserId: BUYER_C,
          shownAsSubprofileId: SHOWN_PERSONA,
          decidedMinute: 2,
        },
      ],
      async () => {
        expect(await wallIds()).toEqual(withPersonaEntry);

        // A direct block names the persona's identity row.
        await withIdentityBlock(VIEWER, SHOWN_IDENTITY, null, async () => {
          expect(await wallIds()).toEqual(withoutPersonaEntry);
        });
        // A carried block names the persona itself.
        await withIdentityBlock(VIEWER, null, SHOWN_PERSONA, async () => {
          expect(await wallIds()).toEqual(withoutPersonaEntry);
          expect(await wallIds(BUYER_F)).toEqual(withPersonaEntry);
        });

        await withRows(
          [
            [
              `DELETE FROM "subprofile_members" WHERE "subprofile_id" = $1 AND "user_id" = $2`,
              [SHOWN_PERSONA, BUYER_C],
            ],
          ],
          [
            [
              `INSERT INTO "subprofile_members" ("subprofile_id", "user_id") VALUES ($1, $2)`,
              [SHOWN_PERSONA, BUYER_C],
            ],
          ],
          async () => {
            expect(await wallIds()).toEqual(withoutPersonaEntry);
          },
        );

        await withRows(
          [
            [
              `INSERT INTO "content_moderation" ("subject_type", "subject_id", "hidden_at")
               VALUES ($1, $2, now())`,
              [SUBPROFILE_MODERATION_SUBJECT_TYPE, SHOWN_PERSONA],
            ],
          ],
          [
            [
              `DELETE FROM "content_moderation" WHERE "subject_id" = $1`,
              [SHOWN_PERSONA],
            ],
          ],
          async () => {
            expect(await wallIds()).toEqual(withoutPersonaEntry);
          },
        );

        expect(await wallIds()).toEqual(withPersonaEntry);
      },
    );
  });

  it('pages by decision time and id without repeats', async () => {
    // Entry `index` is decided `25 - index` minutes after the base, except
    // three entries that share one instant across the page boundary.
    const sharedMinute = 2;
    const purchases = PAGE_BUYERS.map(
      (buyerUserId, index): PurchaseFixture => ({
        id: purchaseId(index + 1),
        buyerUserId,
        decidedMinute: index >= 22 && index <= 24 ? sharedMinute : 25 - index,
      }),
    );
    const expectedIds = [...purchases]
      .sort(
        (left, right) =>
          right.decidedMinute - left.decidedMinute ||
          compareDescending(left.id, right.id),
      )
      .map((purchase) => purchase.id);
    await withPurchases(purchases, async () => {
      const pageSize = STUDIO_PURCHASE_LIMITS.wallPerPage;
      const firstRows = await wallRows();
      expect(firstRows).toHaveLength(pageSize + 1);
      const firstPage = firstRows.slice(0, pageSize);
      const lastRow = firstPage[firstPage.length - 1];
      if (!lastRow) {
        throw new Error('The first page came back empty');
      }
      const secondRows = await wallRows(VIEWER, [
        lastRow.decided_at,
        lastRow.id,
      ]);
      expect(secondRows).toHaveLength(2);

      const pagedIds = [...firstPage, ...secondRows].map((row) => row.id);
      expect(new Set(pagedIds).size).toBe(purchases.length);
      expect(pagedIds).toEqual(expectedIds);
    });
  });
});
