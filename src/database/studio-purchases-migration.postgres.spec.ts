// Lives in `src/database`, outside `src/migrations`: the TypeORM CLI and
// `DatabaseModule` require every `src/migrations/*.ts` file.
import { randomUUID } from 'crypto';
import { DataSource, QueryRunner } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import { AddStudioPurchases1838000000000 } from '../migrations/1838000000000-AddStudioPurchases';
import { User, UserStatus } from '../users/entities/user.entity';

/**
 * Studio purchases migration on real Postgres. Skipped unless
 * `STUDIO_MIGRATIONS_DATABASE_URL` names a database whose name ends in
 * `_test` (it drops and rebuilds the schema). Run it with, for example:
 *
 *   STUDIO_MIGRATIONS_DATABASE_URL=postgres://postgres@127.0.0.1:55450/studio_test \
 *     npx jest src/database/studio-purchases-migration.postgres.spec.ts
 */
const DATABASE_URL = process.env.STUDIO_MIGRATIONS_DATABASE_URL;
const describeWithDatabase = DATABASE_URL ? describe : describe.skip;

const OWNER_USER = 'c9000000-0000-4000-8000-000000000001';
const BUYER_USER = 'c9000000-0000-4000-8000-000000000002';
const ARTIST_PERSONA = 'c9100000-0000-4000-8000-000000000001';
const SECOND_PERSONA = 'c9100000-0000-4000-8000-000000000002';
const ALBUM_ID = 'c9200000-0000-4000-8000-000000000001';
const MIX_ID = 'c9200000-0000-4000-8000-000000000002';
const TRACK_1 = 'c9300000-0000-4000-8000-000000000001';
const TRACK_2 = 'c9300000-0000-4000-8000-000000000002';

const REFERENCE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const DAYS_AGO = '2026-10-20T10:00:00.000Z';

const NEW_ENUM_TYPES = [
  'studio_price_mode',
  'studio_payment_method_kind',
  'studio_purchase_status',
  'studio_purchase_decline_reason',
  'studio_purchase_item_kind',
];

function refuseUnlessTestDatabase(url: string): void {
  const databaseName = new URL(url).pathname.replace(/^\//, '');
  if (!databaseName.endsWith('_test')) {
    throw new Error(
      `Refusing to drop and synchronize "${databaseName}": the name must end in _test`,
    );
  }
}

describeWithDatabase('AddStudioPurchases1838000000000 on real Postgres', () => {
  let dataSource: DataSource;
  let queryRunner: QueryRunner;
  let referenceCounter = 0;
  let isRolledBack = false;

  /** A valid reference code that no other row of this run holds. */
  const nextReferenceCode = (): string => {
    referenceCounter += 1;
    const first = REFERENCE_ALPHABET[Math.floor(referenceCounter / 31) % 31];
    const second = REFERENCE_ALPHABET[referenceCounter % 31];
    return `QP${first}${second}ZZ`;
  };

  const insertUser = async (userId: string = randomUUID()): Promise<string> => {
    await dataSource.getRepository(User).insert({
      id: userId,
      googleId: `google-${userId}`,
      email: `${userId}@example.test`,
      status: UserStatus.Active,
    });
    return userId;
  };

  const insertPersona = async (
    ownerUserId: string,
    kind: string,
    personaId: string = randomUUID(),
  ): Promise<string> => {
    await dataSource.query(
      `INSERT INTO "subprofiles" ("id", "user_id", "kind", "slug", "display_name")
       VALUES ($1, $2, $3, $4, $4)`,
      [personaId, ownerUserId, kind, `persona-${personaId}`],
    );
    await dataSource.query(
      `INSERT INTO "subprofile_members" ("subprofile_id", "user_id") VALUES ($1, $2)`,
      [personaId, ownerUserId],
    );
    return personaId;
  };

  const insertRelease = async (
    personaId: string,
    type: string,
    releaseId: string = randomUUID(),
  ): Promise<string> => {
    await dataSource.query(
      `INSERT INTO "studio_releases" ("id", "subprofile_id", "title", "type", "status", "published_at")
       VALUES ($1, $2, 'Low tide', $3, 'published', now())`,
      [releaseId, personaId, type],
    );
    return releaseId;
  };

  const insertTrack = async (
    releaseId: string,
    position: number,
    trackId: string = randomUUID(),
  ): Promise<string> => {
    await dataSource.query(
      `INSERT INTO "studio_tracks" ("id", "release_id", "position", "title", "audio_key", "duration_seconds")
       VALUES ($1, $2, $3, $4, 'studio-audio/a/b.mp3', 200)`,
      [trackId, releaseId, position, `Track ${position}`],
    );
    return trackId;
  };

  /** Inserts a release claim by `BUYER_USER` on the album unless the
   *  overrides say otherwise, and returns the new purchase id. */
  const insertPurchase = async (
    overrides: Record<string, unknown> = {},
  ): Promise<string> => {
    const values: Record<string, unknown> = {
      buyer_user_id: BUYER_USER,
      subprofile_id: ARTIST_PERSONA,
      artist_name: 'Night Bus',
      item_kind: 'release',
      release_id: ALBUM_ID,
      item_title: 'Low tide',
      amount_cents: 500,
      reference_code: nextReferenceCode(),
      ...overrides,
    };
    const columns = Object.keys(values);
    const rows: { id: string }[] = await dataSource.query(
      `INSERT INTO "studio_purchases" (${columns.map((column) => `"${column}"`).join(', ')})
       VALUES (${columns.map((_column, index) => `$${index + 1}`).join(', ')})
       RETURNING "id"`,
      Object.values(values),
    );
    return rows.map((row) => row.id).join('');
  };

  const clearPurchases = async (): Promise<void> => {
    await dataSource.query(`DELETE FROM "studio_purchases"`);
    await dataSource.query(`DELETE FROM "studio_kept_tracks"`);
  };

  const readPriceRows = (
    tableName: 'studio_releases' | 'studio_tracks',
    rowId: string,
  ): Promise<{ price_mode: string; price_cents: number | null }[]> =>
    dataSource.query(
      `SELECT "price_mode"::text AS "price_mode", "price_cents" FROM "${tableName}" WHERE "id" = $1`,
      [rowId],
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
    // Everything this migration adds comes from the migration under
    // review, so drop what `synchronize` built from the entities first.
    await dataSource.query(`DROP TABLE "studio_purchase_kept_tracks"`);
    await dataSource.query(`DROP TABLE "studio_kept_tracks"`);
    await dataSource.query(`DROP TABLE "studio_purchases"`);
    await dataSource.query(`DROP TABLE "studio_payment_methods"`);
    for (const tableName of ['studio_releases', 'studio_tracks']) {
      await dataSource.query(
        `ALTER TABLE "${tableName}" DROP CONSTRAINT "CHK_${tableName}_price"`,
      );
      await dataSource.query(
        `ALTER TABLE "${tableName}" DROP COLUMN "price_cents", DROP COLUMN "price_mode"`,
      );
    }
    for (const typeName of NEW_ENUM_TYPES) {
      await dataSource.query(`DROP TYPE "${typeName}"`);
    }
    queryRunner = dataSource.createQueryRunner();

    await insertUser(OWNER_USER);
    await insertUser(BUYER_USER);
    await insertPersona(OWNER_USER, 'musician', ARTIST_PERSONA);
    await insertPersona(OWNER_USER, 'dj', SECOND_PERSONA);
    await insertRelease(ARTIST_PERSONA, 'album', ALBUM_ID);
    await insertTrack(ALBUM_ID, 1, TRACK_1);
    await insertTrack(ALBUM_ID, 2, TRACK_2);
    await insertRelease(SECOND_PERSONA, 'mix', MIX_ID);
    await new AddStudioPurchases1838000000000().up(queryRunner);
  }, 120000);

  afterEach(async () => {
    if (isRolledBack) return;
    await clearPurchases();
  });

  afterAll(async () => {
    await queryRunner?.release();
    await dataSource?.destroy();
  });

  it('takes a fixed price from 100 to 50000 cents and a minimum from 0, and refuses a price on a not-for-sale row', async () => {
    const accepted = [
      ['fixed', 100],
      ['fixed', 50000],
      ['name_your_price', 0],
      ['not_for_sale', null],
    ] as const;
    for (const [mode, cents] of accepted) {
      await dataSource.query(
        `UPDATE "studio_releases" SET "price_mode" = $2, "price_cents" = $3 WHERE "id" = $1`,
        [ALBUM_ID, mode, cents],
      );
      await dataSource.query(
        `UPDATE "studio_tracks" SET "price_mode" = $2, "price_cents" = $3 WHERE "id" = $1`,
        [TRACK_1, mode, cents],
      );
    }
    const refused = [
      ['fixed', 99],
      ['fixed', 50001],
      ['name_your_price', -1],
      ['not_for_sale', 500],
      ['fixed', null],
    ] as const;
    for (const [mode, cents] of refused) {
      await expect(
        dataSource.query(
          `UPDATE "studio_releases" SET "price_mode" = $2, "price_cents" = $3 WHERE "id" = $1`,
          [ALBUM_ID, mode, cents],
        ),
      ).rejects.toMatchObject({
        code: '23514',
        constraint: 'CHK_studio_releases_price',
      });
      await expect(
        dataSource.query(
          `UPDATE "studio_tracks" SET "price_mode" = $2, "price_cents" = $3 WHERE "id" = $1`,
          [TRACK_1, mode, cents],
        ),
      ).rejects.toMatchObject({
        code: '23514',
        constraint: 'CHK_studio_tracks_price',
      });
    }
  });

  it('defaults both tables to not for sale', async () => {
    const releaseId = await insertRelease(ARTIST_PERSONA, 'ep');
    const trackId = await insertTrack(releaseId, 1);
    expect(await readPriceRows('studio_releases', releaseId)).toEqual([
      { price_mode: 'not_for_sale', price_cents: null },
    ]);
    expect(await readPriceRows('studio_tracks', trackId)).toEqual([
      { price_mode: 'not_for_sale', price_cents: null },
    ]);
  });

  it('creates the five enum types with their labels in contract order', async () => {
    const rows: { type_name: string; labels: string[] }[] =
      await dataSource.query(
        `SELECT "type"."typname" AS "type_name",
                array_agg("label"."enumlabel"::text ORDER BY "label"."enumsortorder") AS "labels"
           FROM "pg_type" "type"
           JOIN "pg_enum" "label" ON "label"."enumtypid" = "type"."oid"
          WHERE "type"."typname" = ANY($1::text[])
          GROUP BY "type"."typname"
          ORDER BY "type"."typname" COLLATE "C"`,
        [NEW_ENUM_TYPES],
      );
    expect(rows).toEqual([
      {
        type_name: 'studio_payment_method_kind',
        labels: ['link', 'mbway', 'iban'],
      },
      {
        type_name: 'studio_price_mode',
        labels: ['not_for_sale', 'fixed', 'name_your_price'],
      },
      {
        type_name: 'studio_purchase_decline_reason',
        labels: ['payment_not_found', 'amount_different', 'other'],
      },
      { type_name: 'studio_purchase_item_kind', labels: ['release', 'track'] },
      {
        type_name: 'studio_purchase_status',
        labels: ['pending', 'confirmed', 'declined', 'cancelled', 'expired'],
      },
    ]);
  });

  it('refuses a ninth payment method position and a second method in one position', async () => {
    const personaId = await insertPersona(OWNER_USER, 'musician');
    const insertMethod = (position: number): Promise<unknown> =>
      dataSource.query(
        `INSERT INTO "studio_payment_methods" ("subprofile_id", "kind", "value", "position")
         VALUES ($1, 'iban', 'PT50000201231234567890154', $2)`,
        [personaId, position],
      );
    await insertMethod(0);
    await insertMethod(7);
    await expect(insertMethod(8)).rejects.toMatchObject({
      code: '23514',
      constraint: 'CHK_studio_payment_methods_position',
    });
    await expect(insertMethod(-1)).rejects.toMatchObject({ code: '23514' });
    await expect(insertMethod(7)).rejects.toMatchObject({
      code: '23505',
      constraint: 'UQ_studio_payment_methods_subprofile_position',
    });
  });

  it('refuses a purchase with both item ids and accepts one with neither once its item is gone', async () => {
    await expect(
      insertPurchase({ release_id: ALBUM_ID, track_id: TRACK_1 }),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'CHK_studio_purchases_item',
    });
    await expect(
      insertPurchase({
        item_kind: 'track',
        release_id: ALBUM_ID,
        track_id: TRACK_1,
      }),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'CHK_studio_purchases_item',
    });

    const releaseId = await insertRelease(ARTIST_PERSONA, 'single');
    const trackId = await insertTrack(releaseId, 1);
    const purchaseId = await insertPurchase({
      item_kind: 'track',
      release_id: null,
      track_id: trackId,
    });
    await dataSource.query(`DELETE FROM "studio_tracks" WHERE "id" = $1`, [
      trackId,
    ]);
    const rows: { id: string; item_kind: string; track_id: string | null }[] =
      await dataSource.query(
        `SELECT "id", "item_kind"::text AS "item_kind", "track_id" FROM "studio_purchases" WHERE "id" = $1`,
        [purchaseId],
      );
    expect(rows).toEqual([
      { id: purchaseId, item_kind: 'track', track_id: null },
    ]);
  });

  it('refuses an amount above 50000 cents and a negative amount', async () => {
    await expect(insertPurchase({ amount_cents: 50001 })).rejects.toMatchObject(
      { code: '23514', constraint: 'CHK_studio_purchases_amount' },
    );
    await expect(insertPurchase({ amount_cents: -1 })).rejects.toMatchObject({
      code: '23514',
      constraint: 'CHK_studio_purchases_amount',
    });
    await insertPurchase({ amount_cents: 0 });
    await insertPurchase({
      amount_cents: 50000,
      buyer_user_id: await insertUser(),
    });
  });

  it('refuses a reference code outside the unambiguous alphabet', async () => {
    for (const referenceCode of ['QP0K3F', 'qp7k3f', 'QPOK3F', 'QP1K3F']) {
      await expect(
        insertPurchase({ reference_code: referenceCode }),
      ).rejects.toMatchObject({
        code: '23514',
        constraint: 'CHK_studio_purchases_reference_code',
      });
    }
    await insertPurchase({ reference_code: 'QP7K3F' });
    await expect(
      insertPurchase({
        reference_code: 'QP7K3F',
        buyer_user_id: await insertUser(),
      }),
    ).rejects.toMatchObject({
      code: '23505',
      constraint: 'UQ_studio_purchases_reference_code',
    });
  });

  it('ties decided_at to leaving pending and a decline reason to declined', async () => {
    await expect(insertPurchase({ status: 'confirmed' })).rejects.toMatchObject(
      {
        code: '23514',
        constraint: 'CHK_studio_purchases_decided',
      },
    );
    await expect(
      insertPurchase({ status: 'pending', decided_at: DAYS_AGO }),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'CHK_studio_purchases_decided',
    });
    await expect(
      insertPurchase({ status: 'declined', decided_at: DAYS_AGO }),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'CHK_studio_purchases_decline',
    });
    await expect(
      insertPurchase({
        status: 'confirmed',
        decided_at: DAYS_AGO,
        decline_reason: 'other',
      }),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'CHK_studio_purchases_decline',
    });
    await expect(
      insertPurchase({
        status: 'confirmed',
        decided_at: DAYS_AGO,
        decline_note: 'No payment found',
      }),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'CHK_studio_purchases_decline_note',
    });

    await insertPurchase({ status: 'confirmed', decided_at: DAYS_AGO });
    await insertPurchase({
      status: 'declined',
      decided_at: DAYS_AGO,
      decline_reason: 'payment_not_found',
      decline_note: 'No payment found',
    });
    await insertPurchase({ status: 'cancelled', decided_at: DAYS_AGO });
    await insertPurchase({ status: 'expired', decided_at: DAYS_AGO });
  });

  it('refuses a wall persona without the persona flag', async () => {
    await expect(
      insertPurchase({
        is_shown_as_persona: false,
        shown_as_subprofile_id: SECOND_PERSONA,
      }),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'CHK_studio_purchases_wall_identity',
    });
    await insertPurchase({
      is_shown_as_persona: true,
      shown_as_subprofile_id: SECOND_PERSONA,
    });
    await insertPurchase({
      is_shown_as_persona: true,
      shown_as_subprofile_id: null,
      buyer_user_id: await insertUser(),
    });
  });

  it('holds one pending claim per buyer and item and frees the slot once the claim is declined', async () => {
    const firstReleaseClaim = await insertPurchase();
    await expect(insertPurchase()).rejects.toMatchObject({
      code: '23505',
      constraint: 'UQ_studio_purchases_pending_release',
    });
    await insertPurchase({ buyer_user_id: await insertUser() });

    const trackClaim = {
      item_kind: 'track',
      release_id: null,
      track_id: TRACK_1,
    };
    await insertPurchase(trackClaim);
    await expect(insertPurchase(trackClaim)).rejects.toMatchObject({
      code: '23505',
      constraint: 'UQ_studio_purchases_pending_track',
    });

    await dataSource.query(
      `UPDATE "studio_purchases"
          SET "status" = 'declined', "decided_at" = now(), "decline_reason" = 'other'
        WHERE "id" = $1`,
      [firstReleaseClaim],
    );
    await insertPurchase();
  });

  it('keeps the purchase when the buyer, the persona, the release or the decider is deleted', async () => {
    const buyerId = await insertUser();
    const deciderId = await insertUser();
    const doomedPersonaId = await insertPersona(OWNER_USER, 'musician');
    const shownPersonaId = await insertPersona(OWNER_USER, 'dj');
    const doomedReleaseId = await insertRelease(ARTIST_PERSONA, 'ep');

    const buyerPurchase = await insertPurchase({ buyer_user_id: buyerId });
    const deciderPurchase = await insertPurchase({
      buyer_user_id: await insertUser(),
      status: 'confirmed',
      decided_at: DAYS_AGO,
      decided_by_user_id: deciderId,
    });
    const personaPurchase = await insertPurchase({
      buyer_user_id: await insertUser(),
      subprofile_id: doomedPersonaId,
      release_id: null,
    });
    const shownPurchase = await insertPurchase({
      buyer_user_id: await insertUser(),
      is_shown_as_persona: true,
      shown_as_subprofile_id: shownPersonaId,
    });
    const releasePurchase = await insertPurchase({
      buyer_user_id: await insertUser(),
      release_id: doomedReleaseId,
    });

    await dataSource.query(`DELETE FROM "users" WHERE "id" = ANY($1::uuid[])`, [
      [buyerId, deciderId],
    ]);
    await dataSource.query(
      `DELETE FROM "subprofiles" WHERE "id" = ANY($1::uuid[])`,
      [[doomedPersonaId, shownPersonaId]],
    );
    await dataSource.query(`DELETE FROM "studio_releases" WHERE "id" = $1`, [
      doomedReleaseId,
    ]);

    const rows: {
      id: string;
      buyer_user_id: string | null;
      decided_by_user_id: string | null;
      subprofile_id: string | null;
      shown_as_subprofile_id: string | null;
      is_shown_as_persona: boolean;
      release_id: string | null;
      artist_name: string;
      item_title: string;
    }[] = await dataSource.query(
      `SELECT "id", "buyer_user_id", "decided_by_user_id", "subprofile_id", "shown_as_subprofile_id",
              "is_shown_as_persona", "release_id", "artist_name", "item_title"
         FROM "studio_purchases" WHERE "id" = ANY($1::uuid[])`,
      [
        [
          buyerPurchase,
          deciderPurchase,
          personaPurchase,
          shownPurchase,
          releasePurchase,
        ],
      ],
    );
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(rows).toHaveLength(5);
    expect(byId.get(buyerPurchase)?.buyer_user_id).toBeNull();
    expect(byId.get(deciderPurchase)?.decided_by_user_id).toBeNull();
    expect(byId.get(personaPurchase)?.subprofile_id).toBeNull();
    expect(byId.get(shownPurchase)?.shown_as_subprofile_id).toBeNull();
    expect(byId.get(shownPurchase)?.is_shown_as_persona).toBe(true);
    expect(byId.get(releasePurchase)?.release_id).toBeNull();
    expect(rows.map((row) => [row.artist_name, row.item_title])).toEqual(
      Array.from({ length: 5 }, () => ['Night Bus', 'Low tide']),
    );
  });

  it('sets the release and track ids null when they are re-keyed, and follows a re-keyed persona', async () => {
    const personaId = await insertPersona(OWNER_USER, 'musician');
    const shownPersonaId = await insertPersona(OWNER_USER, 'dj');
    const releaseId = await insertRelease(ARTIST_PERSONA, 'single');
    const trackId = await insertTrack(releaseId, 1);
    const otherReleaseId = await insertRelease(ARTIST_PERSONA, 'single');
    const trackPurchase = await insertPurchase({
      item_kind: 'track',
      release_id: null,
      track_id: trackId,
    });
    const releasePurchase = await insertPurchase({
      release_id: otherReleaseId,
    });
    const personaPurchase = await insertPurchase({
      buyer_user_id: await insertUser(),
      subprofile_id: personaId,
      is_shown_as_persona: true,
      shown_as_subprofile_id: shownPersonaId,
    });

    await dataSource.query(
      `UPDATE "studio_tracks" SET "id" = gen_random_uuid() WHERE "id" = $1`,
      [trackId],
    );
    await dataSource.query(
      `UPDATE "studio_releases" SET "id" = gen_random_uuid() WHERE "id" = $1`,
      [otherReleaseId],
    );
    const freshPersonaId = randomUUID();
    const freshShownPersonaId = randomUUID();
    await dataSource.query(
      `UPDATE "subprofiles" SET "id" = $2 WHERE "id" = $1`,
      [personaId, freshPersonaId],
    );
    await dataSource.query(
      `UPDATE "subprofiles" SET "id" = $2 WHERE "id" = $1`,
      [shownPersonaId, freshShownPersonaId],
    );

    const rows: {
      id: string;
      track_id: string | null;
      release_id: string | null;
      subprofile_id: string | null;
      shown_as_subprofile_id: string | null;
    }[] = await dataSource.query(
      `SELECT "id", "track_id", "release_id", "subprofile_id", "shown_as_subprofile_id"
         FROM "studio_purchases" WHERE "id" = ANY($1::uuid[]) ORDER BY "id"`,
      [[trackPurchase, releasePurchase, personaPurchase]],
    );
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(trackPurchase)?.track_id).toBeNull();
    expect(byId.get(releasePurchase)?.release_id).toBeNull();
    expect(byId.get(personaPurchase)?.subprofile_id).toBe(freshPersonaId);
    expect(byId.get(personaPurchase)?.shown_as_subprofile_id).toBe(
      freshShownPersonaId,
    );
  });

  it('cascades payment methods with their persona on delete and update', async () => {
    const personaId = await insertPersona(OWNER_USER, 'musician');
    await dataSource.query(
      `INSERT INTO "studio_payment_methods" ("subprofile_id", "kind", "label", "value", "note", "position")
       VALUES ($1, 'mbway', 'My phone', '+351912345678', 'Evenings only', 0),
              ($1, 'link', NULL, 'https://pay.example.test/night-bus', NULL, 1)`,
      [personaId],
    );
    const freshPersonaId = randomUUID();
    await dataSource.query(
      `UPDATE "subprofiles" SET "id" = $2 WHERE "id" = $1`,
      [personaId, freshPersonaId],
    );
    const followed: { kind: string; label: string | null }[] =
      await dataSource.query(
        `SELECT "kind"::text AS "kind", "label" FROM "studio_payment_methods"
          WHERE "subprofile_id" = $1 ORDER BY "position"`,
        [freshPersonaId],
      );
    expect(followed).toEqual([
      { kind: 'mbway', label: 'My phone' },
      { kind: 'link', label: null },
    ]);

    await dataSource.query(`DELETE FROM "subprofiles" WHERE "id" = $1`, [
      freshPersonaId,
    ]);
    const remaining: { count: number }[] = await dataSource.query(
      `SELECT COUNT(*)::int AS "count" FROM "studio_payment_methods" WHERE "subprofile_id" = $1`,
      [freshPersonaId],
    );
    expect(remaining).toEqual([{ count: 0 }]);
  });

  it('deletes kept links with their purchase and with their kept track, and keeps kept tracks free of catalog keys', async () => {
    const keysToCatalog: { count: number }[] = await dataSource.query(
      `SELECT COUNT(*)::int AS "count"
         FROM "information_schema"."table_constraints"
        WHERE "table_name" = 'studio_kept_tracks' AND "constraint_type" = 'FOREIGN KEY'`,
    );
    expect(keysToCatalog).toEqual([{ count: 0 }]);

    await expect(
      dataSource.query(
        `INSERT INTO "studio_kept_tracks" ("title", "audio_content_type") VALUES ('Harbour', 'audio/mpeg')`,
      ),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'CHK_studio_kept_tracks_audio',
    });

    const keptRows: { id: string }[] = await dataSource.query(
      `INSERT INTO "studio_kept_tracks" ("title", "audio_content_type", "source_audio_key", "audio_key")
       VALUES ('Harbour', 'audio/mpeg', 'studio-audio/a/b.mp3', NULL),
              ('Lights', 'audio/mp4', NULL, 'studio-kept-audio/c.m4a')
       RETURNING "id"`,
    );
    const [firstKeptId, secondKeptId] = keptRows.map((row) => row.id);
    const purchaseId = await insertPurchase({
      status: 'confirmed',
      decided_at: DAYS_AGO,
    });
    const otherPurchaseId = await insertPurchase({
      buyer_user_id: await insertUser(),
      status: 'confirmed',
      decided_at: DAYS_AGO,
    });
    await dataSource.query(
      `INSERT INTO "studio_purchase_kept_tracks" ("purchase_id", "kept_track_id", "position")
       VALUES ($1, $3, 1), ($1, $4, 2), ($2, $3, 1)`,
      [purchaseId, otherPurchaseId, firstKeptId, secondKeptId],
    );
    const countLinks = async (): Promise<number> => {
      const rows: { count: number }[] = await dataSource.query(
        `SELECT COUNT(*)::int AS "count" FROM "studio_purchase_kept_tracks"`,
      );
      return rows
        .map((row) => row.count)
        .reduce((sum, count) => sum + count, 0);
    };
    expect(await countLinks()).toBe(3);

    await dataSource.query(`DELETE FROM "studio_purchases" WHERE "id" = $1`, [
      purchaseId,
    ]);
    expect(await countLinks()).toBe(1);
    const keptAfterPurchaseDelete: { count: number }[] = await dataSource.query(
      `SELECT COUNT(*)::int AS "count" FROM "studio_kept_tracks"`,
    );
    expect(keptAfterPurchaseDelete).toEqual([{ count: 2 }]);

    await dataSource.query(`DELETE FROM "studio_kept_tracks" WHERE "id" = $1`, [
      firstKeptId,
    ]);
    expect(await countLinks()).toBe(0);
  });

  it('orders the buyer list index and the sales index descending', async () => {
    const rows: { indexname: string; indexdef: string }[] =
      await dataSource.query(
        `SELECT "indexname", "indexdef" FROM "pg_indexes"
          WHERE "indexname" IN ('IDX_studio_purchases_buyer_created_at', 'IDX_studio_purchases_subprofile_decided_at')
          ORDER BY "indexname"`,
      );
    expect(rows.map((row) => row.indexdef)).toEqual([
      expect.stringContaining('(buyer_user_id, created_at DESC, id DESC)'),
      expect.stringMatching(
        /\(subprofile_id, decided_at DESC, id DESC\) WHERE \(status = 'confirmed'/,
      ),
    ]);
  });

  it('creates the eleven purchase indexes', async () => {
    const rows: { indexname: string }[] = await dataSource.query(
      `SELECT "indexname" FROM "pg_indexes"
        WHERE "tablename" = 'studio_purchases' AND "indexname" <> 'PK_studio_purchases'
        ORDER BY "indexname" COLLATE "C"`,
    );
    expect(rows.map((row) => row.indexname)).toEqual([
      'IDX_studio_purchases_buyer_created_at',
      'IDX_studio_purchases_decided_by',
      'IDX_studio_purchases_pending_created_at',
      'IDX_studio_purchases_release',
      'IDX_studio_purchases_shown_as',
      'IDX_studio_purchases_subprofile_decided_at',
      'IDX_studio_purchases_subprofile_status_created_at',
      'IDX_studio_purchases_track',
      'UQ_studio_purchases_pending_release',
      'UQ_studio_purchases_pending_track',
      'UQ_studio_purchases_reference_code',
    ]);
  });

  it('drops the tables, the columns, the checks and the five enum types on down', async () => {
    await clearPurchases();
    await new AddStudioPurchases1838000000000().down(queryRunner);
    isRolledBack = true;
    const tables: { table_name: string | null }[] = await dataSource.query(
      `SELECT to_regclass('public.' || "name") AS "table_name"
         FROM unnest(ARRAY['studio_payment_methods', 'studio_purchases', 'studio_kept_tracks', 'studio_purchase_kept_tracks']) AS "name"`,
    );
    const priceColumns: { count: number }[] = await dataSource.query(
      `SELECT COUNT(*)::int AS "count" FROM "information_schema"."columns"
        WHERE "table_name" IN ('studio_releases', 'studio_tracks')
          AND "column_name" IN ('price_mode', 'price_cents')`,
    );
    const priceChecks: { count: number }[] = await dataSource.query(
      `SELECT COUNT(*)::int AS "count" FROM "pg_constraint"
        WHERE "conname" IN ('CHK_studio_releases_price', 'CHK_studio_tracks_price')`,
    );
    const enumTypes: { count: number }[] = await dataSource.query(
      `SELECT COUNT(*)::int AS "count" FROM "pg_type" WHERE "typname" = ANY($1::text[])`,
      [NEW_ENUM_TYPES],
    );
    expect(tables.map((row) => row.table_name)).toEqual([
      null,
      null,
      null,
      null,
    ]);
    expect(priceColumns).toEqual([{ count: 0 }]);
    expect(priceChecks).toEqual([{ count: 0 }]);
    expect(enumTypes).toEqual([{ count: 0 }]);
  });
});
