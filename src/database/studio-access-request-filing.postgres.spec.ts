// Lives in `src/database` beside the other Postgres specs.
import { DataSource } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import { fileStudioAccessRequestForInvite } from '../studio/studio-access-request-filing';
import { STUDIO_LANDING_JOIN_SOURCES } from '../studio/studio.constants';
import { User, UserStatus } from '../users/entities/user.entity';

/**
 * The invite filing of a Studio access request (contract 13) on real
 * Postgres. Skipped unless `STUDIO_MIGRATIONS_DATABASE_URL` names a database
 * whose name ends in `_test` (it drops and synchronizes the schema from the
 * entities).
 */
const DATABASE_URL = process.env.STUDIO_MIGRATIONS_DATABASE_URL;
const describeWithDatabase = DATABASE_URL ? describe : describe.skip;

const USER_ID = 'fc000000-0000-4000-8000-000000000001';
const INVITE_ID = 'fc100000-0000-4000-8000-000000000001';
const OTHER_INVITE_ID = 'fc100000-0000-4000-8000-000000000002';
const EARLIER_REQUEST_AT = new Date('2026-10-20T09:30:00.000Z');

interface RequestRow {
  wants_to_release: boolean;
  is_from_invite: boolean;
  created_at: Date;
}

function refuseUnlessTestDatabase(url: string): void {
  const databaseName = new URL(url).pathname.replace(/^\//, '');
  if (!databaseName.endsWith('_test')) {
    throw new Error(
      `Refusing to drop and synchronize "${databaseName}": the name must end in _test`,
    );
  }
}

describeWithDatabase('Studio access request filing on real Postgres', () => {
  let dataSource: DataSource;
  let joinRequestCount = 0;

  const insertJoinRequest = async (
    inviteId: string,
    source: string | null,
  ): Promise<void> => {
    joinRequestCount += 1;
    await dataSource.query(
      `INSERT INTO "join_requests" ("name", "email", "message", "source", "status", "age_attested_at", "terms_version", "invite_id")
       VALUES ('Applicant', $1, 'Hello', $2, 'approved', now(), '2.4', $3)`,
      [`applicant-${joinRequestCount}@example.test`, source, inviteId],
    );
  };

  const fileInTransaction = (inviteId: string): Promise<void> =>
    dataSource.transaction((manager) =>
      fileStudioAccessRequestForInvite(manager, inviteId, USER_ID),
    );

  const requestFlags = async (): Promise<[boolean, boolean][]> => {
    const rows: RequestRow[] = await dataSource.query(
      `SELECT "wants_to_release", "is_from_invite", "created_at"
         FROM "studio_access_requests" WHERE "user_id" = $1`,
      [USER_ID],
    );
    return rows.map((row): [boolean, boolean] => [
      row.wants_to_release,
      row.is_from_invite,
    ]);
  };

  const countRequests = async (): Promise<number> => {
    const rows: { count: number }[] = await dataSource.query(
      `SELECT count(*)::int AS "count" FROM "studio_access_requests"`,
    );
    return rows.map((row) => row.count).reduce((sum, count) => sum + count, 0);
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
    await dataSource.getRepository(User).insert({
      id: USER_ID,
      googleId: `google-${USER_ID}`,
      email: `${USER_ID}@example.test`,
      status: UserStatus.Active,
    });
  }, 120000);

  afterEach(async () => {
    await dataSource.query(`DELETE FROM "studio_access_requests"`);
    await dataSource.query(`DELETE FROM "join_requests"`);
  });

  afterAll(async () => {
    await dataSource?.destroy();
  });

  it('files an artist request for a studio_artist join request', async () => {
    await insertJoinRequest(INVITE_ID, STUDIO_LANDING_JOIN_SOURCES.artist);

    await fileInTransaction(INVITE_ID);

    expect(await requestFlags()).toEqual([[true, true]]);
  });

  it('files a listener request for a studio_landing join request', async () => {
    await insertJoinRequest(INVITE_ID, STUDIO_LANDING_JOIN_SOURCES.listener);

    await fileInTransaction(INVITE_ID);

    expect(await requestFlags()).toEqual([[false, true]]);
  });

  it('reads artist when two join requests carry both sources', async () => {
    await insertJoinRequest(INVITE_ID, STUDIO_LANDING_JOIN_SOURCES.listener);
    await insertJoinRequest(INVITE_ID, STUDIO_LANDING_JOIN_SOURCES.artist);

    await fileInTransaction(INVITE_ID);

    expect(await requestFlags()).toEqual([[true, true]]);
  });

  it('files nothing for another source or no join request', async () => {
    await insertJoinRequest(INVITE_ID, 'homepage_hero');
    await insertJoinRequest(INVITE_ID, null);
    await insertJoinRequest(
      OTHER_INVITE_ID,
      STUDIO_LANDING_JOIN_SOURCES.artist,
    );

    await fileInTransaction(INVITE_ID);
    expect(await countRequests()).toBe(0);

    await fileInTransaction('fc100000-0000-4000-8000-000000000003');
    expect(await countRequests()).toBe(0);
  });

  it('keeps a request the member already filed', async () => {
    await dataSource.query(
      `INSERT INTO "studio_access_requests" ("user_id", "wants_to_release", "is_from_invite", "created_at")
       VALUES ($1, false, false, $2)`,
      [USER_ID, EARLIER_REQUEST_AT],
    );
    await insertJoinRequest(INVITE_ID, STUDIO_LANDING_JOIN_SOURCES.artist);

    await fileInTransaction(INVITE_ID);

    const rows: RequestRow[] = await dataSource.query(
      `SELECT "wants_to_release", "is_from_invite", "created_at"
         FROM "studio_access_requests" WHERE "user_id" = $1`,
      [USER_ID],
    );
    expect(
      rows.map((row) => [
        row.wants_to_release,
        row.is_from_invite,
        row.created_at.toISOString(),
      ]),
    ).toEqual([[false, false, EARLIER_REQUEST_AT.toISOString()]]);
  });

  it('files nothing when the signup transaction rolls back', async () => {
    await insertJoinRequest(INVITE_ID, STUDIO_LANDING_JOIN_SOURCES.artist);

    await expect(
      dataSource.transaction(async (manager) => {
        await fileStudioAccessRequestForInvite(manager, INVITE_ID, USER_ID);
        throw new Error('signup failed');
      }),
    ).rejects.toThrow('signup failed');

    expect(await countRequests()).toBe(0);
  });
});
