// Lives in `src/database`, outside `src/migrations`: the TypeORM CLI and
// `DatabaseModule` require every `src/migrations/*.ts` file.
import { DataSource, QueryRunner } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import { AddStudioSafetyEnumValues1834000000000 } from '../migrations/1834000000000-AddStudioSafetyEnumValues';
import { AddStudioSafety1834000100000 } from '../migrations/1834000100000-AddStudioSafety';
import {
  Subprofile,
  SubprofileKind,
} from '../subprofiles/entities/subprofile.entity';
import { User, UserStatus } from '../users/entities/user.entity';

/**
 * The Studio safety migrations on real Postgres. Skipped unless
 * `STUDIO_MIGRATIONS_DATABASE_URL` names a database whose name ends in
 * `_test` (it drops and synchronizes the schema). Run it with, for example:
 *
 *   STUDIO_MIGRATIONS_DATABASE_URL=postgres://postgres@127.0.0.1:55450/studio_test \
 *     npx jest src/database/studio-safety-migrations.postgres.spec.ts
 */
const DATABASE_URL = process.env.STUDIO_MIGRATIONS_DATABASE_URL;
const describeWithDatabase = DATABASE_URL ? describe : describe.skip;

const OWNER_USER = 'b5000000-0000-4000-8000-000000000001';
const CLAIMANT_USER = 'b5000000-0000-4000-8000-000000000002';
const STAFF_USER = 'b5000000-0000-4000-8000-000000000003';
const PERSONA_ID = 'b5100000-0000-4000-8000-000000000001';
const RELEASE_ID = 'b5200000-0000-4000-8000-000000000001';
const TRACK_ID = 'b5300000-0000-4000-8000-000000000001';
const REKEYED_TRACK_ID = 'b5300000-0000-4000-8000-000000000002';

function refuseUnlessTestDatabase(url: string): void {
  const databaseName = new URL(url).pathname.replace(/^\//, '');
  if (!databaseName.endsWith('_test')) {
    throw new Error(
      `Refusing to drop and synchronize "${databaseName}": the name must end in _test`,
    );
  }
}

describeWithDatabase('AddStudioSafety migrations on real Postgres', () => {
  let dataSource: DataSource;
  let queryRunner: QueryRunner;

  const insertClaim = (columns: Record<string, unknown>): Promise<unknown> => {
    const row: Record<string, unknown> = {
      track_id: TRACK_ID,
      release_id: RELEASE_ID,
      claimant_id: CLAIMANT_USER,
      claimant_role: 'rights_holder',
      original_work: 'Saudade by Ana Moura',
      details: 'The hook from 0:40 is lifted whole',
      good_faith_at: new Date('2026-10-14T09:00:00.000Z'),
      track_title_at_filing: 'Opening',
      artist_name_at_filing: 'Night Shift',
      ...columns,
    };
    const names = Object.keys(row);
    return dataSource.query(
      `INSERT INTO "studio_copyright_claims" (${names
        .map((name) => `"${name}"`)
        .join(', ')}) VALUES (${names
        .map((_name, index) => `$${index + 1}`)
        .join(', ')})`,
      names.map((name) => row[name]),
    );
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
    // What the schema migration under review creates, dropped from the
    // synchronized schema so the migration builds it.
    await dataSource.query(`DROP TABLE "studio_copyright_claims"`);
    await dataSource.query(`DROP TYPE "studio_copyright_claims_status_enum"`);
    await dataSource.query(
      `DROP TYPE "studio_copyright_claims_claimant_role_enum"`,
    );
    await dataSource.query(
      `ALTER TABLE "studio_tracks"
         DROP CONSTRAINT IF EXISTS "CHK_studio_tracks_content_warnings",
         DROP CONSTRAINT IF EXISTS "CHK_studio_tracks_staff_content_warnings",
         DROP CONSTRAINT IF EXISTS "CHK_studio_tracks_explicit_locked",
         DROP COLUMN "content_warnings",
         DROP COLUMN "staff_content_warnings",
         DROP COLUMN "explicit_locked_at",
         DROP COLUMN "withheld_at"`,
    );
    await dataSource.query(
      `ALTER TABLE "member_preferences" DROP COLUMN "studio_ask_before_warnings"`,
    );
    await dataSource.getRepository(User).insert(
      [OWNER_USER, CLAIMANT_USER, STAFF_USER].map((userId) => ({
        id: userId,
        googleId: `google-${userId}`,
        email: `${userId}@example.test`,
        status: UserStatus.Active,
      })),
    );
    await dataSource.getRepository(Subprofile).insert({
      id: PERSONA_ID,
      userId: OWNER_USER,
      slug: 'night-shift',
      displayName: 'Night Shift',
      kind: SubprofileKind.Dj,
    });
    await dataSource.query(
      `INSERT INTO "studio_releases" ("id", "subprofile_id", "title", "type", "status", "published_at")
       VALUES ($1, $2, 'Lisbon at four', 'mix', 'published', now())`,
      [RELEASE_ID, PERSONA_ID],
    );
    await dataSource.query(
      `INSERT INTO "studio_tracks" ("id", "release_id", "position", "title")
       VALUES ($1, $2, 1, 'Opening')`,
      [TRACK_ID, RELEASE_ID],
    );
    await dataSource.query(
      `INSERT INTO "member_preferences" ("user_id") VALUES ($1)`,
      [CLAIMANT_USER],
    );
    queryRunner = dataSource.createQueryRunner();
    // The enum labels already exist (synchronize built them from the
    // entities); `IF NOT EXISTS` keeps this a no-op that must not throw.
    await new AddStudioSafetyEnumValues1834000000000().up(queryRunner);
    await new AddStudioSafety1834000100000().up(queryRunner);
  }, 120000);

  afterAll(async () => {
    await queryRunner?.release();
    await dataSource?.destroy();
  });

  it('runs outside a transaction for the enum labels', () => {
    expect(new AddStudioSafetyEnumValues1834000000000().transaction).toBe(
      false,
    );
  });

  it('gives an existing track empty warning lists and no stamps', async () => {
    expect(
      await dataSource.query(
        `SELECT "content_warnings", "staff_content_warnings", "explicit_locked_at", "withheld_at"
           FROM "studio_tracks" WHERE "id" = $1`,
        [TRACK_ID],
      ),
    ).toEqual([
      {
        content_warnings: [],
        staff_content_warnings: [],
        explicit_locked_at: null,
        withheld_at: null,
      },
    ]);
  });

  it('gives an existing preferences row the ask-first default', async () => {
    expect(
      await dataSource.query(
        `SELECT "studio_ask_before_warnings" FROM "member_preferences" WHERE "user_id" = $1`,
        [CLAIMANT_USER],
      ),
    ).toEqual([{ studio_ask_before_warnings: true }]);
  });

  it('takes known theme ids and refuses an unknown one or a ninth', async () => {
    await dataSource.query(
      `UPDATE "studio_tracks" SET "content_warnings" = ARRAY['medical', 'police']::text[] WHERE "id" = $1`,
      [TRACK_ID],
    );
    await expect(
      dataSource.query(
        `UPDATE "studio_tracks" SET "content_warnings" = ARRAY['gore']::text[] WHERE "id" = $1`,
        [TRACK_ID],
      ),
    ).rejects.toThrow(/CHK_studio_tracks_content_warnings/);
    await expect(
      dataSource.query(
        `UPDATE "studio_tracks" SET "staff_content_warnings" =
           ARRAY['medical', 'violence', 'substances', 'family-rejection', 'sexual-content', 'self-harm', 'housing-loss', 'police', 'police']::text[]
         WHERE "id" = $1`,
        [TRACK_ID],
      ),
    ).rejects.toThrow(/CHK_studio_tracks_staff_content_warnings/);
  });

  it('refuses an explicit lock on a track that is not explicit', async () => {
    await expect(
      dataSource.query(
        `UPDATE "studio_tracks" SET "explicit_locked_at" = now(), "is_explicit" = false WHERE "id" = $1`,
        [TRACK_ID],
      ),
    ).rejects.toThrow(/CHK_studio_tracks_explicit_locked/);
    await dataSource.query(
      `UPDATE "studio_tracks" SET "explicit_locked_at" = now(), "is_explicit" = true WHERE "id" = $1`,
      [TRACK_ID],
    );
  });

  it('stores no artist member: a claim names its track, release, claimant and deciding staff member', async () => {
    const columns: { column_name: string }[] = await dataSource.query(
      `SELECT "column_name" FROM "information_schema"."columns"
        WHERE "table_name" = 'studio_copyright_claims' ORDER BY "column_name"`,
    );
    expect(columns.map((column) => column.column_name)).toEqual([
      'accepted_at',
      'artist_name_at_filing',
      'claimant_id',
      'claimant_reply',
      'claimant_role',
      'counter_note',
      'countered_at',
      'created_at',
      'decided_at',
      'decided_by_id',
      'details',
      'good_faith_at',
      'id',
      'is_severed',
      'original_link',
      'original_work',
      'release_id',
      'replied_at',
      'staff_note',
      'status',
      'track_id',
      'track_title_at_filing',
      'updated_at',
    ]);
  });

  it('builds the names kept at filing as the entity declares them', async () => {
    const columns: {
      column_name: string;
      data_type: string;
      character_maximum_length: number | null;
      is_nullable: string;
      column_default: string | null;
    }[] = await dataSource.query(
      `SELECT "column_name", "data_type", "character_maximum_length", "is_nullable", "column_default"
         FROM "information_schema"."columns"
        WHERE "table_name" = 'studio_copyright_claims'
          AND "column_name" IN ('track_title_at_filing', 'artist_name_at_filing', 'is_severed')
        ORDER BY "column_name"`,
    );
    expect(columns).toEqual([
      {
        column_name: 'artist_name_at_filing',
        data_type: 'character varying',
        character_maximum_length: 120,
        is_nullable: 'NO',
        column_default: null,
      },
      {
        column_name: 'is_severed',
        data_type: 'boolean',
        character_maximum_length: null,
        is_nullable: 'NO',
        column_default: 'false',
      },
      {
        column_name: 'track_title_at_filing',
        data_type: 'character varying',
        character_maximum_length: 120,
        is_nullable: 'NO',
        column_default: null,
      },
    ]);
  });

  it('refuses a claim with no track title kept at filing', async () => {
    await expect(insertClaim({ track_title_at_filing: null })).rejects.toThrow(
      /track_title_at_filing/,
    );
  });

  it('files a claim as submitted and refuses a second live one by the same claimant', async () => {
    await insertClaim({});
    expect(
      await dataSource.query(
        `SELECT "status"::text AS "status" FROM "studio_copyright_claims"`,
      ),
    ).toEqual([{ status: 'submitted' }]);
    await expect(insertClaim({})).rejects.toThrow(
      /UQ_studio_copyright_claims_live_track_claimant/,
    );
  });

  it('takes a new claim once the earlier one is withdrawn', async () => {
    await dataSource.query(
      `UPDATE "studio_copyright_claims" SET "status" = 'withdrawn'`,
    );
    await insertClaim({});
    expect(
      await dataSource.query(
        `SELECT "status"::text AS "status" FROM "studio_copyright_claims" ORDER BY "created_at", "id"`,
      ),
    ).toHaveLength(2);
  });

  it('ties every stamp and note to its status', async () => {
    await expect(
      dataSource.query(
        `UPDATE "studio_copyright_claims" SET "status" = 'accepted' WHERE "status" = 'submitted'`,
      ),
    ).rejects.toThrow(/CHK_studio_copyright_claims_accepted/);
    await expect(
      dataSource.query(
        `UPDATE "studio_copyright_claims" SET "status" = 'declined', "decided_at" = now() WHERE "status" = 'submitted'`,
      ),
    ).rejects.toThrow(/CHK_studio_copyright_claims_staff_note/);
    await expect(
      dataSource.query(
        `UPDATE "studio_copyright_claims" SET "status" = 'declined', "staff_note" = 'Not enough to go on' WHERE "status" = 'submitted'`,
      ),
    ).rejects.toThrow(/CHK_studio_copyright_claims_decided/);
    await expect(
      dataSource.query(
        `UPDATE "studio_copyright_claims" SET "counter_note" = 'I wrote it' WHERE "status" = 'submitted'`,
      ),
    ).rejects.toThrow(/CHK_studio_copyright_claims_counter_pair/);
    await expect(
      dataSource.query(
        `UPDATE "studio_copyright_claims" SET "claimant_reply" = 'I did not' WHERE "status" = 'submitted'`,
      ),
    ).rejects.toThrow(/CHK_studio_copyright_claims_reply_pair/);
  });

  it('takes an http or https link and refuses any other scheme', async () => {
    await dataSource.query(
      `UPDATE "studio_copyright_claims" SET "original_link" = 'http://example.test/a' WHERE "status" = 'submitted'`,
    );
    await expect(
      dataSource.query(
        `UPDATE "studio_copyright_claims" SET "original_link" = 'ftp://example.test/a' WHERE "status" = 'submitted'`,
      ),
    ).rejects.toThrow(/CHK_studio_copyright_claims_original_link/);
  });

  it('keeps a decision when the deciding staff account goes', async () => {
    await dataSource.query(
      `UPDATE "studio_copyright_claims"
          SET "status" = 'accepted', "accepted_at" = now(), "decided_by_id" = $1
        WHERE "status" = 'submitted'`,
      [STAFF_USER],
    );
    await dataSource.query(`DELETE FROM "users" WHERE "id" = $1`, [STAFF_USER]);
    expect(
      await dataSource.query(
        `SELECT "decided_by_id" FROM "studio_copyright_claims" WHERE "status" = 'accepted'`,
      ),
    ).toEqual([{ decided_by_id: null }]);
  });

  it('carries claims to the fresh track id an unlink issues', async () => {
    await dataSource.query(
      `UPDATE "studio_tracks" SET "id" = $1 WHERE "id" = $2`,
      [REKEYED_TRACK_ID, TRACK_ID],
    );
    const rows: { track_id: string }[] = await dataSource.query(
      `SELECT DISTINCT "track_id" FROM "studio_copyright_claims"`,
    );
    expect(rows).toEqual([{ track_id: REKEYED_TRACK_ID }]);
  });

  it("removes a member's claims with their account", async () => {
    await dataSource.query(`DELETE FROM "users" WHERE "id" = $1`, [
      CLAIMANT_USER,
    ]);
    expect(
      await dataSource.query(`SELECT "id" FROM "studio_copyright_claims"`),
    ).toEqual([]);
  });

  it('runs down and up again', async () => {
    await new AddStudioSafety1834000100000().down(queryRunner);
    expect(
      await dataSource.query(
        `SELECT "table_name" FROM "information_schema"."tables"
          WHERE "table_name" = 'studio_copyright_claims'`,
      ),
    ).toEqual([]);
    await new AddStudioSafety1834000100000().up(queryRunner);
  });

  it('refuses to go down for the enum labels', async () => {
    await expect(
      new AddStudioSafetyEnumValues1834000000000().down(),
    ).rejects.toThrow(/Irreversible/);
  });
});
