// Lives in `src/database` beside the other Postgres specs.
import { HttpException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, QueryRunner } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import { StudioRelease } from '../studio/entities/studio-release.entity';
import { StudioOwnershipService } from '../studio/studio-ownership.service';
import {
  LOCK_PURCHASE_SQL,
  PENDING_COUNT_SQL,
  StudioSalesService,
} from '../studio/studio-sales.service';
import { SubprofileMember } from '../subprofiles/entities/subprofile-member.entity';
import {
  Subprofile,
  SubprofileKind,
  SubprofileStatus,
  SubprofileVisibility,
} from '../subprofiles/entities/subprofile.entity';
import { Profile } from '../users/entities/profile.entity';
import { User, UserStatus } from '../users/entities/user.entity';

/**
 * Studio purchase decisions under concurrency on real Postgres (contract 3.9,
 * 3.11, 4.2 and 4.3). Skipped unless `STUDIO_MIGRATIONS_DATABASE_URL` names a
 * database whose name ends in `_test` (it drops and synchronizes the schema
 * from the entities).
 */
const DATABASE_URL = process.env.STUDIO_MIGRATIONS_DATABASE_URL;
const describeWithDatabase = DATABASE_URL ? describe : describe.skip;

const ARTIST_CREATOR = 'd1000000-0000-4000-8000-000000000001';
const CO_OWNER = 'd1000000-0000-4000-8000-000000000002';
const BUYER = 'd1000000-0000-4000-8000-000000000003';
const MUSIC_PERSONA = 'd2000000-0000-4000-8000-000000000001';
const RELEASE_ID = 'd4000000-0000-4000-8000-000000000001';
const PURCHASE_ID = 'd6000000-0000-4000-8000-000000000001';

/** The inner select of the contract 4.3 expiry batch. */
const EXPIRY_CANDIDATES_SQL = `SELECT "id" FROM "studio_purchases"
    WHERE "status" = 'pending'
      AND "created_at" < now() - interval '30 days'
    ORDER BY "created_at" ASC
    LIMIT 500
    FOR UPDATE SKIP LOCKED`;

/** How long a statement gets to show it is waiting on a row lock. */
const LOCK_WAIT_MILLISECONDS = 300;

interface DecisionRow {
  status: string;
  decided_by_user_id: string | null;
  decided_at: Date | null;
}

function refuseUnlessTestDatabase(url: string): void {
  const databaseName = new URL(url).pathname.replace(/^\//, '');
  if (!databaseName.endsWith('_test')) {
    throw new Error(
      `Refusing to drop and synchronize "${databaseName}": the name must end in _test`,
    );
  }
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return ((error as HttpException).getResponse() as { code?: string }).code;
  }
}

/** True when the promise settled within the window; a statement blocked on
 *  a row lock stays unsettled. */
async function settlesWithin(
  promise: Promise<unknown>,
  milliseconds: number,
): Promise<boolean> {
  let isSettled = false;
  void promise.then(
    () => {
      isSettled = true;
    },
    () => {
      isSettled = true;
    },
  );
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
  return isSettled;
}

describeWithDatabase('Studio sales decisions on real Postgres', () => {
  let dataSource: DataSource;
  let service: StudioSalesService;
  let emit: jest.Mock;
  const openRunners: QueryRunner[] = [];

  const openTransaction = async (): Promise<QueryRunner> => {
    const runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    openRunners.push(runner);
    return runner;
  };

  const insertPendingPurchase = (createdDaysAgo = 1): Promise<unknown> =>
    dataSource.query(
      `INSERT INTO "studio_purchases"
         ("id", "buyer_user_id", "subprofile_id", "artist_name", "item_kind",
          "release_id", "item_title", "amount_cents", "reference_code", "created_at")
       VALUES ($1, $2, $3, 'Harbour Lights', 'release', $4, 'Low tide', 800, 'QPAB23',
               now() - make_interval(days => $5::int))`,
      [PURCHASE_ID, BUYER, MUSIC_PERSONA, RELEASE_ID, createdDaysAgo],
    );

  const decisionRows = async (): Promise<DecisionRow[]> =>
    dataSource.query(
      `SELECT "status"::text AS "status", "decided_by_user_id", "decided_at"
         FROM "studio_purchases" WHERE "id" = $1`,
      [PURCHASE_ID],
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
      [ARTIST_CREATOR, CO_OWNER, BUYER].map((userId) => ({
        id: userId,
        googleId: `google-${userId}`,
        email: `${userId}@example.test`,
        status: UserStatus.Active,
      })),
    );
    await dataSource.query(
      `INSERT INTO "studio_access_grants" ("user_id") SELECT unnest($1::uuid[])`,
      [[ARTIST_CREATOR, CO_OWNER, BUYER]],
    );
    await dataSource.getRepository(Subprofile).insert({
      id: MUSIC_PERSONA,
      userId: ARTIST_CREATOR,
      slug: 'harbour-lights',
      handle: 'harbour-lights',
      displayName: 'Harbour Lights',
      kind: SubprofileKind.Musician,
      status: SubprofileStatus.Published,
      visibility: SubprofileVisibility.Open,
    });
    // The co-owner holds a member row alone; `subprofiles.user_id` names
    // the creator.
    await dataSource.getRepository(SubprofileMember).insert([
      { subprofileId: MUSIC_PERSONA, userId: ARTIST_CREATOR },
      { subprofileId: MUSIC_PERSONA, userId: CO_OWNER },
    ]);
    await dataSource.query(
      `INSERT INTO "studio_releases" ("id", "subprofile_id", "title", "type", "status", "published_at")
       VALUES ($1, $2, 'Low tide', 'album', 'published', now())`,
      [RELEASE_ID, MUSIC_PERSONA],
    );

    emit = jest.fn();
    service = new StudioSalesService(
      dataSource,
      new StudioOwnershipService(
        dataSource.getRepository(SubprofileMember),
        dataSource.getRepository(Subprofile),
        dataSource.getRepository(StudioRelease),
      ),
      dataSource.getRepository(Profile),
      { emit } as unknown as EventEmitter2,
    );
  });

  beforeEach(async () => {
    emit.mockClear();
    await dataSource.query(`DELETE FROM "studio_purchases"`);
    await insertPendingPurchase();
  });

  afterEach(async () => {
    for (const runner of openRunners.splice(0)) {
      if (runner.isTransactionActive) {
        await runner.rollbackTransaction();
      }
      await runner.release();
    }
  });

  afterAll(async () => {
    await dataSource?.destroy();
  });

  it('lets the first of two confirmations win and answers the second with studio_purchase_not_pending', async () => {
    const firstRunner = await openTransaction();
    const secondRunner = await openTransaction();

    await firstRunner.query(LOCK_PURCHASE_SQL, [PURCHASE_ID]);
    await firstRunner.query(
      `UPDATE "studio_purchases"
          SET "status" = 'confirmed', "decided_at" = now(),
              "decided_by_user_id" = $2, "updated_at" = now()
        WHERE "id" = $1`,
      [PURCHASE_ID, ARTIST_CREATOR],
    );

    const secondLock: Promise<{ status: string }[]> = secondRunner.query(
      LOCK_PURCHASE_SQL,
      [PURCHASE_ID],
    );
    expect(await settlesWithin(secondLock, LOCK_WAIT_MILLISECONDS)).toBe(false);

    await firstRunner.commitTransaction();
    expect((await secondLock).map((row) => row.status)).toEqual(['confirmed']);
    await secondRunner.rollbackTransaction();

    expect(
      await codeOf(service.confirm(CO_OWNER, MUSIC_PERSONA, PURCHASE_ID)),
    ).toBe('studio_purchase_not_pending');
    expect(
      (await decisionRows()).map((row) => [
        row.status,
        row.decided_by_user_id,
        row.decided_at !== null,
      ]),
    ).toEqual([['confirmed', ARTIST_CREATOR, true]]);
    expect(emit).not.toHaveBeenCalled();
  });

  it('lets a cancel that commits first turn a confirmation into studio_purchase_not_pending', async () => {
    const buyerRunner = await openTransaction();
    await buyerRunner.query(LOCK_PURCHASE_SQL, [PURCHASE_ID]);
    await buyerRunner.query(
      `UPDATE "studio_purchases"
          SET "status" = 'cancelled', "decided_at" = now(), "updated_at" = now()
        WHERE "id" = $1`,
      [PURCHASE_ID],
    );

    const confirmationCode = codeOf(
      service.confirm(CO_OWNER, MUSIC_PERSONA, PURCHASE_ID),
    );
    expect(await settlesWithin(confirmationCode, LOCK_WAIT_MILLISECONDS)).toBe(
      false,
    );

    await buyerRunner.commitTransaction();
    expect(await confirmationCode).toBe('studio_purchase_not_pending');
    expect(
      (await decisionRows()).map((row) => [row.status, row.decided_by_user_id]),
    ).toEqual([['cancelled', null]]);
    expect(emit).not.toHaveBeenCalled();
  });

  it('leaves a locked pending row to a later expiry run (SKIP LOCKED)', async () => {
    await dataSource.query(`DELETE FROM "studio_purchases"`);
    await insertPendingPurchase(31);

    const deciderRunner = await openTransaction();
    await deciderRunner.query(LOCK_PURCHASE_SQL, [PURCHASE_ID]);

    const expiryRunner = await openTransaction();
    expect(await expiryRunner.query(EXPIRY_CANDIDATES_SQL)).toEqual([]);
    await expiryRunner.rollbackTransaction();

    // Once the lock is gone the same row is a candidate again.
    await deciderRunner.rollbackTransaction();
    const laterRunner = await openTransaction();
    expect(await laterRunner.query(EXPIRY_CANDIDATES_SQL)).toEqual([
      { id: PURCHASE_ID },
    ]);
  });

  it('reads the pending count of a co-owner who is in subprofile_members only', async () => {
    expect(await dataSource.query(PENDING_COUNT_SQL, [CO_OWNER])).toEqual([
      { subprofile_id: MUSIC_PERSONA, count: 1 },
    ]);
    await expect(service.pendingCount(CO_OWNER)).resolves.toEqual({
      count: 1,
      byPersona: [{ subprofileId: MUSIC_PERSONA, count: 1 }],
    });
    await expect(service.pendingCount(BUYER)).resolves.toEqual({
      count: 0,
      byPersona: [],
    });

    await service.confirm(CO_OWNER, MUSIC_PERSONA, PURCHASE_ID);
    await expect(service.pendingCount(CO_OWNER)).resolves.toEqual({
      count: 0,
      byPersona: [],
    });
    expect(
      (await decisionRows()).map((row) => [row.status, row.decided_by_user_id]),
    ).toEqual([['confirmed', CO_OWNER]]);
  });
});
