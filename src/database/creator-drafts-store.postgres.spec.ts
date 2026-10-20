// Lives in `src/database`, outside `src/migrations`: the TypeORM CLI and
// `DatabaseModule` require every `src/migrations/*.ts` file.
import { DataSource } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import {
  type CreatorDraftSaveOutcome,
  type CreatorDraftSlot,
  type CreatorDraftWrite,
  creatorDraftExpiryCutoff,
  deleteCreatorDraftWithin,
  readCreatorDraftWithin,
  saveCreatorDraftWithin,
} from '../creator-drafts/creator-draft-store';
import { DEFAULT_CREATOR_DRAFT_RETENTION_DAYS } from '../creator-drafts/creator-drafts.constants';
import { AddCreatorDrafts1835000000000 } from '../migrations/1835000000000-AddCreatorDrafts';

/**
 * Creator draft store on real Postgres. Skipped unless
 * `CREATOR_DRAFTS_DATABASE_URL` names a database whose name ends in `_test`
 * (it drops the schema). The entities load for metadata only; the table comes
 * from the migration over stub `users`, `communities` and `listings` tables.
 * Run it with, for example:
 *
 *   CREATOR_DRAFTS_DATABASE_URL=postgres://postgres@127.0.0.1:55450/creator_drafts_test \
 *     npx jest src/database/creator-drafts-store.postgres.spec.ts
 */
const DATABASE_URL = process.env.CREATOR_DRAFTS_DATABASE_URL;
const describeWithDatabase = DATABASE_URL ? describe : describe.skip;

const AUTHOR_ID = 'c9100000-0000-4000-8000-000000000001';

const SLOT: CreatorDraftSlot = {
  userId: AUTHOR_ID,
  kind: 'event',
  slotKey: '',
};

const FIRST_PAYLOAD = { title: 'Picnic' };
const SECOND_PAYLOAD = { title: 'Picnic in the park' };
const THIRD_PAYLOAD = { title: 'Picnic in the park on Sunday' };
const PAYLOAD_A = { title: 'Typed in tab A' };
const PAYLOAD_B = { title: 'Typed in tab B' };

const BASE_WRITE: Omit<CreatorDraftWrite, 'payload' | 'baseRevision'> = {
  payloadVersion: 1,
  progress: { done: 1, total: 5 },
  missing: ['who'],
  madeForCommunityId: null,
  madeForListingId: null,
};

/** The revision a refused save reports, or null for a save that landed or
 *  an empty slot. */
function currentRevisionOf(outcome: CreatorDraftSaveOutcome): number | null {
  if (outcome.isSaved) return null;
  return outcome.current === null ? null : outcome.current.revision;
}

function refuseUnlessTestDatabase(url: string): void {
  const databaseName = new URL(url).pathname.replace(/^\//, '');
  if (!databaseName.endsWith('_test')) {
    throw new Error(
      `Refusing to drop the schema of "${databaseName}": the name must end in _test`,
    );
  }
}

describeWithDatabase('creator draft store on real Postgres', () => {
  let dataSource: DataSource;

  function currentCutoff(): Date {
    return creatorDraftExpiryCutoff(
      new Date(),
      DEFAULT_CREATOR_DRAFT_RETENTION_DAYS,
    );
  }

  function save(
    slot: CreatorDraftSlot,
    baseRevision: number | null,
    payload: Record<string, unknown>,
  ): Promise<CreatorDraftSaveOutcome> {
    return saveCreatorDraftWithin(
      dataSource.manager,
      slot,
      { ...BASE_WRITE, baseRevision, payload },
      currentCutoff(),
    );
  }

  async function payloadOf(
    slot: CreatorDraftSlot,
  ): Promise<Record<string, unknown> | undefined> {
    const rows: { payload: Record<string, unknown> }[] = await dataSource.query(
      `SELECT "payload" FROM "creator_drafts" WHERE "user_id" = $1 AND "kind" = $2 AND "slot_key" = $3`,
      [slot.userId, slot.kind, slot.slotKey],
    );
    return rows[0]?.payload;
  }

  async function countDrafts(): Promise<number> {
    const rows: { count: number }[] = await dataSource.query(
      `SELECT COUNT(*)::int AS "count" FROM "creator_drafts"`,
    );
    const [countRow] = rows;
    if (!countRow) throw new Error('COUNT(*) answered no row');
    return countRow.count;
  }

  async function idOf(slot: CreatorDraftSlot): Promise<string | undefined> {
    const rows: { id: string }[] = await dataSource.query(
      `SELECT "id" FROM "creator_drafts" WHERE "user_id" = $1 AND "kind" = $2 AND "slot_key" = $3`,
      [slot.userId, slot.kind, slot.slotKey],
    );
    return rows[0]?.id;
  }

  /** Moves every draft one day past the 90-day window. */
  async function ageAllDraftsPastTheWindow(): Promise<void> {
    await dataSource.query(
      `UPDATE "creator_drafts" SET "updated_at" = now() - interval '91 days'`,
    );
  }

  /** Revisions 1, 2 and 3, ending on `THIRD_PAYLOAD`. */
  async function saveThreeRevisions(): Promise<void> {
    await save(SLOT, null, FIRST_PAYLOAD);
    await save(SLOT, 1, SECOND_PAYLOAD);
    await save(SLOT, 2, THIRD_PAYLOAD);
  }

  beforeAll(async () => {
    refuseUnlessTestDatabase(DATABASE_URL!);
    dataSource = new DataSource({
      type: 'postgres',
      url: DATABASE_URL,
      entities: [`${__dirname}/../**/*.entity.ts`],
      namingStrategy: new SnakeNamingStrategy(),
      dropSchema: true,
      synchronize: false,
    });
    await dataSource.initialize();
    await dataSource.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    await dataSource.query(`CREATE TABLE "users" ("id" uuid PRIMARY KEY)`);
    await dataSource.query(
      `CREATE TABLE "communities" ("id" uuid PRIMARY KEY)`,
    );
    await dataSource.query(`CREATE TABLE "listings" ("id" uuid PRIMARY KEY)`);
    const queryRunner = dataSource.createQueryRunner();
    try {
      await new AddCreatorDrafts1835000000000().up(queryRunner);
    } finally {
      await queryRunner.release();
    }
    await dataSource.query(`INSERT INTO "users" ("id") VALUES ($1)`, [
      AUTHOR_ID,
    ]);
  });

  beforeEach(async () => {
    await dataSource.query(`DELETE FROM "creator_drafts"`);
  });

  afterAll(async () => {
    await dataSource?.destroy();
  });

  it('saves, bumps the revision by one and keeps one row per slot', async () => {
    const first = await save(SLOT, null, FIRST_PAYLOAD);
    const second = await save(SLOT, 1, SECOND_PAYLOAD);
    const third = await save(SLOT, 2, THIRD_PAYLOAD);
    expect([first, second, third].map((outcome) => outcome.isSaved)).toEqual([
      true,
      true,
      true,
    ]);
    expect(
      [first, second, third].map((outcome) =>
        outcome.isSaved ? outcome.revision : null,
      ),
    ).toEqual([1, 2, 3]);
    expect(third).toEqual(
      expect.objectContaining({ savedAt: expect.any(Date) as Date }),
    );
    expect(await countDrafts()).toBe(1);
    expect(await payloadOf(SLOT)).toEqual(THIRD_PAYLOAD);
  });

  it('writes nothing on a stale base revision and reports the current one', async () => {
    await saveThreeRevisions();
    const outcome = await save(SLOT, 2, PAYLOAD_A);
    expect(outcome).toEqual({
      isSaved: false,
      current: { revision: 3, savedAt: expect.any(Date) as Date },
    });
    expect(await payloadOf(SLOT)).toEqual(THIRD_PAYLOAD);
  });

  it('refuses a null base on a filled slot', async () => {
    await saveThreeRevisions();
    const outcome = await save(SLOT, null, PAYLOAD_A);
    expect(outcome.isSaved).toBe(false);
    expect(currentRevisionOf(outcome)).toBe(3);
    expect(await payloadOf(SLOT)).toEqual(THIRD_PAYLOAD);
  });

  it('answers an empty current for a base on an emptied slot', async () => {
    await saveThreeRevisions();
    await deleteCreatorDraftWithin(dataSource.manager, SLOT);
    const outcome = await save(SLOT, 3, PAYLOAD_A);
    expect(outcome).toEqual({ isSaved: false, current: null });
    expect(await countDrafts()).toBe(0);
  });

  it('replaces an expired row on a null base and starts again at one', async () => {
    await saveThreeRevisions();
    const expiredId = await idOf(SLOT);
    await ageAllDraftsPastTheWindow();
    const outcome = await save(SLOT, null, PAYLOAD_A);
    expect(outcome).toEqual({
      isSaved: true,
      revision: 1,
      savedAt: expect.any(Date) as Date,
    });
    expect(await payloadOf(SLOT)).toEqual(PAYLOAD_A);
    expect(await countDrafts()).toBe(1);
    const replacementId = await idOf(SLOT);
    expect(replacementId).toEqual(expect.any(String));
    expect(replacementId).not.toBe(expiredId);
  });

  it('answers an empty current for a base on an expired slot', async () => {
    await saveThreeRevisions();
    await ageAllDraftsPastTheWindow();
    const outcome = await save(SLOT, 3, PAYLOAD_A);
    expect(outcome).toEqual({ isSaved: false, current: null });
    expect(await payloadOf(SLOT)).toEqual(THIRD_PAYLOAD);
  });

  it('reads an expired row as absent', async () => {
    await saveThreeRevisions();
    expect(
      await readCreatorDraftWithin(dataSource.manager, SLOT, currentCutoff()),
    ).toEqual(expect.objectContaining({ revision: 3 }));
    await ageAllDraftsPastTheWindow();
    expect(
      await readCreatorDraftWithin(dataSource.manager, SLOT, currentCutoff()),
    ).toBeNull();
  });

  it('keeps two tabs racing on one base to a single winner', async () => {
    await saveThreeRevisions();
    const [outcomeA, outcomeB] = await Promise.all([
      save(SLOT, 3, PAYLOAD_A),
      save(SLOT, 3, PAYLOAD_B),
    ]);
    expect([outcomeA.isSaved, outcomeB.isSaved].filter(Boolean)).toHaveLength(
      1,
    );
    const loser = outcomeA.isSaved ? outcomeB : outcomeA;
    expect(currentRevisionOf(loser)).toBe(4);
    expect(await payloadOf(SLOT)).toEqual(
      outcomeA.isSaved ? PAYLOAD_A : PAYLOAD_B,
    );
    expect(await countDrafts()).toBe(1);
  });

  it('keeps two null-base saves racing on an empty slot to a single winner', async () => {
    const [outcomeA, outcomeB] = await Promise.all([
      save(SLOT, null, PAYLOAD_A),
      save(SLOT, null, PAYLOAD_B),
    ]);
    expect([outcomeA.isSaved, outcomeB.isSaved].filter(Boolean)).toHaveLength(
      1,
    );
    const loser = outcomeA.isSaved ? outcomeB : outcomeA;
    expect(currentRevisionOf(loser)).toBe(1);
    expect(await countDrafts()).toBe(1);
  });
});
