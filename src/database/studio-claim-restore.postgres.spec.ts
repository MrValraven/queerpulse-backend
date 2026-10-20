// Lives in `src/database`, outside `src/migrations`.
import { DataSource } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import {
  restoreTracksHeldByClaimantWithin,
  restoreWithheldTrackWithin,
  withholdTrackWithin,
} from '../studio/studio-claim-store';
import {
  Subprofile,
  SubprofileKind,
} from '../subprofiles/entities/subprofile.entity';
import { User, UserStatus } from '../users/entities/user.entity';

/**
 * Studio safety: the restore rule on real Postgres. Skipped unless
 * `STUDIO_MIGRATIONS_DATABASE_URL` names a database whose name ends in
 * `_test` (it drops and synchronizes the schema).
 */
const DATABASE_URL = process.env.STUDIO_MIGRATIONS_DATABASE_URL;
const describeWithDatabase = DATABASE_URL ? describe : describe.skip;

const OWNER_USER = 'ba000000-0000-4000-8000-000000000001';
const FIRST_CLAIMANT = 'ba000000-0000-4000-8000-000000000002';
const SECOND_CLAIMANT = 'ba000000-0000-4000-8000-000000000003';
const PERSONA_ID = 'ba100000-0000-4000-8000-000000000001';
const RELEASE_ID = 'ba200000-0000-4000-8000-000000000001';
const TRACK_ID = 'ba300000-0000-4000-8000-000000000001';

function refuseUnlessTestDatabase(url: string): void {
  const databaseName = new URL(url).pathname.replace(/^\//, '');
  if (!databaseName.endsWith('_test')) {
    throw new Error(
      `Refusing to drop and synchronize "${databaseName}": the name must end in _test`,
    );
  }
}

describeWithDatabase('Studio claim restore rule on real Postgres', () => {
  let dataSource: DataSource;

  const withheldAt = async (): Promise<Date | null> => {
    const [row]: { withheld_at: Date | null }[] = await dataSource.query(
      `SELECT "withheld_at" FROM "studio_tracks" WHERE "id" = $1`,
      [TRACK_ID],
    );
    return row?.withheld_at ?? null;
  };

  const holdBy = (claimantId: string): Promise<unknown> =>
    dataSource.query(
      `INSERT INTO "studio_copyright_claims"
         ("track_id", "release_id", "claimant_id", "claimant_role", "original_work", "details", "good_faith_at", "status", "accepted_at", "track_title_at_filing", "artist_name_at_filing")
       VALUES ($1, $2, $3, 'rights_holder', 'Saudade', 'The hook', now(), 'accepted', now(), 'Opening', 'Night Shift')`,
      [TRACK_ID, RELEASE_ID, claimantId],
    );

  const decide = (claimantId: string, status: string): Promise<unknown> =>
    dataSource.query(
      `UPDATE "studio_copyright_claims"
          SET "status" = $2::studio_copyright_claims_status_enum, "decided_at" = now(), "staff_note" = 'Decided'
        WHERE "claimant_id" = $1 AND "status" IN ('accepted', 'countered')`,
      [claimantId, status],
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
      [OWNER_USER, FIRST_CLAIMANT, SECOND_CLAIMANT].map((userId) => ({
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
      `INSERT INTO "studio_tracks" ("id", "release_id", "position", "title", "audio_key", "duration_seconds")
       VALUES ($1, $2, 1, 'Opening', 'studio-audio/a/b.mp3', 200)`,
      [TRACK_ID, RELEASE_ID],
    );
  }, 120000);

  afterAll(async () => {
    await dataSource?.destroy();
  });

  it('withholds a track once and keeps the first stamp', async () => {
    await withholdTrackWithin(dataSource.manager, TRACK_ID);
    const firstStamp = await withheldAt();
    expect(firstStamp).not.toBeNull();
    await withholdTrackWithin(dataSource.manager, TRACK_ID);
    expect(await withheldAt()).toEqual(firstStamp);
  });

  it('keeps a track withheld while a second claim still holds it', async () => {
    await holdBy(FIRST_CLAIMANT);
    await holdBy(SECOND_CLAIMANT);
    await decide(FIRST_CLAIMANT, 'rejected');
    expect(await restoreWithheldTrackWithin(dataSource.manager, TRACK_ID)).toBe(
      false,
    );
    expect(await withheldAt()).not.toBeNull();
  });

  // Plan decision (Wire contract as built, item 13): an upheld claim keeps
  // the track offline, so rejecting a second claim brings nothing back.
  it('keeps a track withheld while an upheld claim stands', async () => {
    await decide(SECOND_CLAIMANT, 'upheld');
    expect(await restoreWithheldTrackWithin(dataSource.manager, TRACK_ID)).toBe(
      false,
    );
    expect(await withheldAt()).not.toBeNull();
  });

  it('restores the track once no claim withholds it', async () => {
    // The account cascade removes the upheld claim with its claimant.
    await dataSource.query(
      `DELETE FROM "studio_copyright_claims" WHERE "claimant_id" = $1`,
      [SECOND_CLAIMANT],
    );
    expect(await restoreWithheldTrackWithin(dataSource.manager, TRACK_ID)).toBe(
      true,
    );
    expect(await withheldAt()).toBeNull();
  });

  it('keeps a track another member still holds when one claimant is erased', async () => {
    await withholdTrackWithin(dataSource.manager, TRACK_ID);
    await holdBy(FIRST_CLAIMANT);
    await holdBy(SECOND_CLAIMANT);
    expect(
      await restoreTracksHeldByClaimantWithin(
        dataSource.manager,
        FIRST_CLAIMANT,
      ),
    ).toEqual([]);
    expect(await withheldAt()).not.toBeNull();
  });

  it('restores a track the erased claimant alone held', async () => {
    await decide(SECOND_CLAIMANT, 'rejected');
    expect(
      await restoreTracksHeldByClaimantWithin(
        dataSource.manager,
        FIRST_CLAIMANT,
      ),
    ).toEqual([TRACK_ID]);
    expect(await withheldAt()).toBeNull();
  });

  // Our team's decision stands: the erasure restores from accepted or
  // countered claims only, and an upheld claim of the erased claimant
  // keeps the track offline after the cascade removes it.
  it('keeps a track withheld when an upheld claim of the erased claimant holds it', async () => {
    await dataSource.query(`DELETE FROM "studio_copyright_claims"`);
    await withholdTrackWithin(dataSource.manager, TRACK_ID);
    await holdBy(FIRST_CLAIMANT);
    await decide(FIRST_CLAIMANT, 'upheld');
    expect(
      await restoreTracksHeldByClaimantWithin(
        dataSource.manager,
        FIRST_CLAIMANT,
      ),
    ).toEqual([]);
    expect(await withheldAt()).not.toBeNull();
  });

  it('keeps a track withheld when the erased claimant holds it twice and one claim was upheld', async () => {
    await holdBy(FIRST_CLAIMANT);
    expect(
      await restoreTracksHeldByClaimantWithin(
        dataSource.manager,
        FIRST_CLAIMANT,
      ),
    ).toEqual([]);
    expect(await withheldAt()).not.toBeNull();
  });

  it('locks the tracks before the restore inside one transaction', async () => {
    await dataSource.query(`DELETE FROM "studio_copyright_claims"`);
    await withholdTrackWithin(dataSource.manager, TRACK_ID);
    await holdBy(FIRST_CLAIMANT);
    const restoredTrackIds = await dataSource.transaction(async (manager) => {
      const trackIds = await restoreTracksHeldByClaimantWithin(
        manager,
        FIRST_CLAIMANT,
      );
      const locks: { mode: string }[] = await manager.query(
        `SELECT "lock"."mode" AS "mode" FROM "pg_locks" "lock"
          WHERE "lock"."locktype" = 'relation'
            AND "lock"."relation" = 'studio_tracks'::regclass
            AND "lock"."pid" = pg_backend_pid()`,
      );
      expect(locks.map((lock) => lock.mode)).toContain('RowShareLock');
      return trackIds;
    });
    expect(restoredTrackIds).toEqual([TRACK_ID]);
    expect(await withheldAt()).toBeNull();
  });
});
