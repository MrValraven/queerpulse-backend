// Lives in `src/database`, outside `src/migrations`: the TypeORM CLI and
// `DatabaseModule` both require every `src/migrations/*.ts` file, and
// requiring a spec there throws `describe is not defined` before any
// migration runs.
import { DataSource, QueryRunner } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import { ContentModeration } from '../content-moderation/entities/content-moderation.entity';
import { AddSubprofileAddressHistory1821500200000 } from '../migrations/1821500200000-AddSubprofileAddressHistory';
import { RepairOrphanedPersonaCreators1821500400000 } from '../migrations/1821500400000-RepairOrphanedPersonaCreators';
import { SubprofileMember } from '../subprofiles/entities/subprofile-member.entity';
import {
  Subprofile,
  SubprofileKind,
  SubprofileLinkVisibility,
} from '../subprofiles/entities/subprofile.entity';
import { User, UserStatus } from '../users/entities/user.entity';
import {
  readRepairOrphanedPersonaCreatorsTally,
  REPAIR_ORPHANED_PERSONA_CREATORS_SQL,
  RepairOrphanedPersonaCreatorsTally,
} from './repair-orphaned-persona-creators.sql';

/**
 * `REPAIR_ORPHANED_PERSONA_CREATORS_SQL` on real Postgres, running on the
 * table `AddSubprofileAddressHistory1821500200000` creates. The first run
 * executes the constant itself, exactly as the post-deploy operator step
 * does; the second run goes through
 * `RepairOrphanedPersonaCreators1821500400000.up()`, which executes the same
 * constant, and finds nothing left to do.
 *
 * Every orphaned persona (creator without a member row, other members
 * present) moves to its longest-standing member, ties broken by member id.
 * An active member is preferred over an earlier suspended or deactivated
 * one, and the longest-standing member takes over when none is active.
 * The slug is kept when free and suffixed when the successor already uses
 * it, including against a persona repaired earlier in the same run. The
 * vacated address of a Linked persona lands in the history table, an
 * Unlinked persona leaves none, a still-active takedown follows a renamed
 * slug while a lifted one stays behind, a persona whose last member is erased
 * mid-run is skipped and listed, and healthy or memberless personas stay as
 * they were.
 *
 * It runs against a real database and is skipped unless
 * `REPAIR_ORPHANED_PERSONAS_DATABASE_URL` names one. It builds the schema
 * with `synchronize` after dropping every table, so it refuses any database
 * whose name does not end in `_test`. Run it with, for example:
 *
 *   REPAIR_ORPHANED_PERSONAS_DATABASE_URL=postgres://postgres@127.0.0.1:55450/persona_repair_test \
 *     npx jest src/database/repair-orphaned-persona-creators-migration.postgres.spec.ts
 */
const DATABASE_URL = process.env.REPAIR_ORPHANED_PERSONAS_DATABASE_URL;
const describeWithDatabase = DATABASE_URL ? describe : describe.skip;

const DEPARTED_CREATOR = '10000000-0000-4000-8000-000000000001';
const EARLIEST_MEMBER = '10000000-0000-4000-8000-000000000002';
const LATER_MEMBER = '10000000-0000-4000-8000-000000000003';
const TIED_MEMBER_LOW_ID = '10000000-0000-4000-8000-000000000004';
const TIED_MEMBER_HIGH_ID = '10000000-0000-4000-8000-000000000005';
const BUSY_SUCCESSOR = '10000000-0000-4000-8000-000000000006';
const HEALTHY_CREATOR = '10000000-0000-4000-8000-000000000007';
const HEALTHY_CO_OWNER = '10000000-0000-4000-8000-000000000008';
const SUSPENDED_MEMBER = '10000000-0000-4000-8000-000000000009';
const DEACTIVATED_MEMBER = '10000000-0000-4000-8000-000000000010';
const ALL_USERS = [
  DEPARTED_CREATOR,
  EARLIEST_MEMBER,
  LATER_MEMBER,
  TIED_MEMBER_LOW_ID,
  TIED_MEMBER_HIGH_ID,
  BUSY_SUCCESSOR,
  HEALTHY_CREATOR,
  HEALTHY_CO_OWNER,
  SUSPENDED_MEMBER,
  DEACTIVATED_MEMBER,
];
const STATUS_BY_USER: Record<string, UserStatus> = {
  [SUSPENDED_MEMBER]: UserStatus.Suspended,
  [DEACTIVATED_MEMBER]: UserStatus.Deactivated,
};

// Orphaned: earliest member takes over, slug free.
const PLAIN_ORPHAN = '20000000-0000-4000-8000-000000000001';
// Orphaned: two members joined at the same instant, lower member id wins.
const TIED_ORPHAN = '20000000-0000-4000-8000-000000000002';
// Orphaned: the successor already holds `studio` and `studio-2`.
const COLLIDING_ORPHAN = '20000000-0000-4000-8000-000000000003';
// Two orphans named `shared`, both handed to the busy successor.
const FIRST_SHARED_ORPHAN = '20000000-0000-4000-8000-000000000004';
const SECOND_SHARED_ORPHAN = '20000000-0000-4000-8000-000000000005';
// Orphaned: `archive` and `archive-2` are taken, and `archive-3` already
// carries a takedown of its own.
const MERGING_ORPHAN = '20000000-0000-4000-8000-000000000006';
// Healthy: the creator still has a member row.
const HEALTHY_PERSONA = '20000000-0000-4000-8000-000000000007';
// No member row at all: nobody to hand it to.
const MEMBERLESS_PERSONA = '20000000-0000-4000-8000-000000000008';
// Unlinked orphan: moves, and records no history row.
const UNLINKED_ORPHAN = '20000000-0000-4000-8000-000000000021';
// Suspended and deactivated members joined first; the later active one wins.
const ACTIVE_PREFERRED_ORPHAN = '20000000-0000-4000-8000-000000000022';
// Only inactive members: the longest-standing one takes over.
const INACTIVE_ONLY_ORPHAN = '20000000-0000-4000-8000-000000000023';
// Renamed to `lifted-2`; its lifted moderation row stays behind.
const LIFTED_ORPHAN = '20000000-0000-4000-8000-000000000024';
// Orphaned when the run starts; a spec-only trigger erases its one member
// while LIFTED_ORPHAN is repaired, so the run finds nobody to hand it to.
const VANISHING_ORPHAN = '20000000-0000-4000-8000-000000000025';
// The busy successor's own personas.
const BUSY_STUDIO = '20000000-0000-4000-8000-000000000011';
const BUSY_STUDIO_TWO = '20000000-0000-4000-8000-000000000012';
const BUSY_ARCHIVE = '20000000-0000-4000-8000-000000000013';
const BUSY_ARCHIVE_TWO = '20000000-0000-4000-8000-000000000014';
const BUSY_LIFTED = '20000000-0000-4000-8000-000000000015';

const MEMBER_ID_LOW = '30000000-0000-4000-8000-000000000001';
const MEMBER_ID_HIGH = '30000000-0000-4000-8000-00000000000f';

const HOUR_MS = 60 * 60 * 1000;
const BASE_TIME = new Date('2026-09-01T09:00:00.000Z').getTime();
const atHour = (hour: number) => new Date(BASE_TIME + hour * HOUR_MS);

async function seedFixture(dataSource: DataSource): Promise<void> {
  await dataSource.getRepository(User).insert(
    ALL_USERS.map((userId) => ({
      id: userId,
      googleId: `google-${userId}`,
      email: `${userId}@example.test`,
      status: STATUS_BY_USER[userId] ?? UserStatus.Active,
    })),
  );

  const persona = (
    id: string,
    userId: string,
    slug: string,
    createdAtHour: number,
    linkVisibility = SubprofileLinkVisibility.Linked,
  ) => ({
    id,
    userId,
    slug,
    displayName: `Persona ${slug}`,
    kind: SubprofileKind.Generic,
    linkVisibility,
    createdAt: atHour(createdAtHour),
  });
  await dataSource
    .getRepository(Subprofile)
    .insert([
      persona(BUSY_STUDIO, BUSY_SUCCESSOR, 'studio', 0),
      persona(BUSY_STUDIO_TWO, BUSY_SUCCESSOR, 'studio-2', 0),
      persona(BUSY_ARCHIVE, BUSY_SUCCESSOR, 'archive', 0),
      persona(BUSY_ARCHIVE_TWO, BUSY_SUCCESSOR, 'archive-2', 0),
      persona(PLAIN_ORPHAN, DEPARTED_CREATOR, 'plain', 1),
      persona(TIED_ORPHAN, DEPARTED_CREATOR, 'tied', 2),
      persona(COLLIDING_ORPHAN, DEPARTED_CREATOR, 'studio', 3),
      persona(FIRST_SHARED_ORPHAN, DEPARTED_CREATOR, 'shared', 4),
      persona(SECOND_SHARED_ORPHAN, EARLIEST_MEMBER, 'shared', 5),
      persona(MERGING_ORPHAN, LATER_MEMBER, 'archive', 6),
      persona(HEALTHY_PERSONA, HEALTHY_CREATOR, 'healthy', 7),
      persona(MEMBERLESS_PERSONA, DEPARTED_CREATOR, 'memberless', 8),
      persona(BUSY_LIFTED, BUSY_SUCCESSOR, 'lifted', 0),
      persona(
        UNLINKED_ORPHAN,
        DEPARTED_CREATOR,
        'hidden-name',
        9,
        SubprofileLinkVisibility.Unlinked,
      ),
      persona(ACTIVE_PREFERRED_ORPHAN, DEPARTED_CREATOR, 'prefer', 10),
      persona(INACTIVE_ONLY_ORPHAN, DEPARTED_CREATOR, 'dormant', 11),
      persona(LIFTED_ORPHAN, DEPARTED_CREATOR, 'lifted', 12),
      persona(VANISHING_ORPHAN, DEPARTED_CREATOR, 'vanishing', 13),
    ]);

  await dataSource.getRepository(SubprofileMember).insert([
    {
      subprofileId: BUSY_LIFTED,
      userId: BUSY_SUCCESSOR,
      joinedAt: atHour(0),
    },
    {
      subprofileId: UNLINKED_ORPHAN,
      userId: HEALTHY_CO_OWNER,
      joinedAt: atHour(9),
    },
    // ACTIVE_PREFERRED_ORPHAN: both inactive members joined first.
    {
      subprofileId: ACTIVE_PREFERRED_ORPHAN,
      userId: SUSPENDED_MEMBER,
      joinedAt: atHour(1),
    },
    {
      subprofileId: ACTIVE_PREFERRED_ORPHAN,
      userId: DEACTIVATED_MEMBER,
      joinedAt: atHour(2),
    },
    {
      subprofileId: ACTIVE_PREFERRED_ORPHAN,
      userId: LATER_MEMBER,
      joinedAt: atHour(3),
    },
    // INACTIVE_ONLY_ORPHAN: the suspended member joined first.
    {
      subprofileId: INACTIVE_ONLY_ORPHAN,
      userId: DEACTIVATED_MEMBER,
      joinedAt: atHour(5),
    },
    {
      subprofileId: INACTIVE_ONLY_ORPHAN,
      userId: SUSPENDED_MEMBER,
      joinedAt: atHour(4),
    },
    {
      subprofileId: LIFTED_ORPHAN,
      userId: BUSY_SUCCESSOR,
      joinedAt: atHour(12),
    },
    {
      subprofileId: VANISHING_ORPHAN,
      userId: HEALTHY_CO_OWNER,
      joinedAt: atHour(13),
    },
    {
      subprofileId: BUSY_STUDIO,
      userId: BUSY_SUCCESSOR,
      joinedAt: atHour(0),
    },
    {
      subprofileId: BUSY_STUDIO_TWO,
      userId: BUSY_SUCCESSOR,
      joinedAt: atHour(0),
    },
    {
      subprofileId: BUSY_ARCHIVE,
      userId: BUSY_SUCCESSOR,
      joinedAt: atHour(0),
    },
    {
      subprofileId: BUSY_ARCHIVE_TWO,
      userId: BUSY_SUCCESSOR,
      joinedAt: atHour(0),
    },
    // PLAIN_ORPHAN: the later member row is inserted first on purpose.
    { subprofileId: PLAIN_ORPHAN, userId: LATER_MEMBER, joinedAt: atHour(3) },
    {
      subprofileId: PLAIN_ORPHAN,
      userId: EARLIEST_MEMBER,
      joinedAt: atHour(2),
    },
    // TIED_ORPHAN: same instant, the high id is inserted first on purpose.
    {
      id: MEMBER_ID_HIGH,
      subprofileId: TIED_ORPHAN,
      userId: TIED_MEMBER_HIGH_ID,
      joinedAt: atHour(4),
    },
    {
      id: MEMBER_ID_LOW,
      subprofileId: TIED_ORPHAN,
      userId: TIED_MEMBER_LOW_ID,
      joinedAt: atHour(4),
    },
    {
      subprofileId: COLLIDING_ORPHAN,
      userId: BUSY_SUCCESSOR,
      joinedAt: atHour(4),
    },
    {
      subprofileId: FIRST_SHARED_ORPHAN,
      userId: BUSY_SUCCESSOR,
      joinedAt: atHour(5),
    },
    {
      subprofileId: SECOND_SHARED_ORPHAN,
      userId: BUSY_SUCCESSOR,
      joinedAt: atHour(6),
    },
    {
      subprofileId: MERGING_ORPHAN,
      userId: BUSY_SUCCESSOR,
      joinedAt: atHour(7),
    },
    {
      subprofileId: HEALTHY_PERSONA,
      userId: HEALTHY_CREATOR,
      joinedAt: atHour(7),
    },
    {
      subprofileId: HEALTHY_PERSONA,
      userId: HEALTHY_CO_OWNER,
      joinedAt: atHour(8),
    },
  ]);

  await dataSource.getRepository(ContentModeration).insert([
    // Removed persona `studio`: follows COLLIDING_ORPHAN to its new slug.
    {
      subjectType: 'subprofile',
      subjectId: 'studio',
      removedAt: atHour(9),
      reasonCode: 'spam',
    },
    // `archive` is hidden, and its target `archive-3` is already removed.
    { subjectType: 'subprofile', subjectId: 'archive', hiddenAt: atHour(9) },
    {
      subjectType: 'subprofile',
      subjectId: 'archive-3',
      removedAt: atHour(10),
    },
    // A lifted takedown on `lifted`: nothing to carry to `lifted-2`.
    { subjectType: 'subprofile', subjectId: 'lifted', note: 'lifted' },
  ]);
}

/**
 * Stands in for an account erasure that lands mid-run: when the repair writes
 * LIFTED_ORPHAN's history row, VANISHING_ORPHAN loses its only member, the
 * way `FK_subprofile_members_user ON DELETE CASCADE` would remove it.
 */
async function installMidRunErasure(dataSource: DataSource): Promise<void> {
  await dataSource.query(`
    CREATE FUNCTION "spec_erase_vanishing_member"() RETURNS trigger AS $spec$
    BEGIN
      IF NEW."subprofile_id" = '${LIFTED_ORPHAN}' THEN
        DELETE FROM "subprofile_members"
         WHERE "subprofile_id" = '${VANISHING_ORPHAN}';
      END IF;
      RETURN NEW;
    END
    $spec$ LANGUAGE plpgsql
  `);
  await dataSource.query(`
    CREATE TRIGGER "spec_erase_vanishing_member"
      AFTER INSERT ON "subprofile_address_history"
      FOR EACH ROW EXECUTE FUNCTION "spec_erase_vanishing_member"()
  `);
}

async function removeMidRunErasure(dataSource: DataSource): Promise<void> {
  await dataSource.query(
    `DROP TRIGGER "spec_erase_vanishing_member" ON "subprofile_address_history"`,
  );
  await dataSource.query(`DROP FUNCTION "spec_erase_vanishing_member"()`);
}

describeWithDatabase(
  'REPAIR_ORPHANED_PERSONA_CREATORS_SQL on real Postgres',
  () => {
    let dataSource: DataSource;
    let queryRunner: QueryRunner;
    let repairTally: RepairOrphanedPersonaCreatorsTally;

    const personaRow = (id: string) =>
      dataSource.getRepository(Subprofile).findOneByOrFail({ id });

    const historyRows = async (): Promise<
      { previous_user_id: string; slug: string; subprofile_id: string }[]
    > =>
      await dataSource.query(
        `SELECT "previous_user_id", "slug", "subprofile_id"
           FROM "subprofile_address_history"
          ORDER BY "slug" ASC, "subprofile_id" ASC`,
      );

    const moderationFor = (subjectId: string) =>
      dataSource
        .getRepository(ContentModeration)
        .findOneBy({ subjectType: 'subprofile', subjectId });

    beforeAll(async () => {
      const databaseName = new URL(DATABASE_URL!).pathname.replace(/^\//, '');
      if (!databaseName.endsWith('_test')) {
        throw new Error(
          `Refusing to drop and synchronize "${databaseName}": the name must end in _test`,
        );
      }
      dataSource = new DataSource({
        type: 'postgres',
        url: DATABASE_URL,
        entities: [`${__dirname}/../**/*.entity.ts`],
        namingStrategy: new SnakeNamingStrategy(),
        dropSchema: true,
        synchronize: true,
      });
      await dataSource.initialize();
      // The table comes from the migration under review, so drop the copy
      // `synchronize` built from the entity and let the migration create it.
      await dataSource.query(`DROP TABLE "subprofile_address_history"`);
      queryRunner = dataSource.createQueryRunner();
      await new AddSubprofileAddressHistory1821500200000().up(queryRunner);

      await seedFixture(dataSource);
      await installMidRunErasure(dataSource);

      // The exact text an operator runs. The transaction is only there so
      // the tally can be read back before it ends.
      await queryRunner.startTransaction();
      await queryRunner.query(REPAIR_ORPHANED_PERSONA_CREATORS_SQL);
      repairTally = await readRepairOrphanedPersonaCreatorsTally(queryRunner);
      await queryRunner.commitTransaction();

      await removeMidRunErasure(dataSource);
    }, 120000);

    afterAll(async () => {
      await queryRunner?.release();
      await dataSource?.destroy();
    });

    it('hands a persona to its earliest-joined member and keeps a free slug', async () => {
      const persona = await personaRow(PLAIN_ORPHAN);
      expect(persona.userId).toBe(EARLIEST_MEMBER);
      expect(persona.slug).toBe('plain');
    });

    it('breaks a joined_at tie by the lower member id', async () => {
      const persona = await personaRow(TIED_ORPHAN);
      expect(persona.userId).toBe(TIED_MEMBER_LOW_ID);
      expect(persona.slug).toBe('tied');
    });

    it('suffixes past every slug the successor already holds', async () => {
      const persona = await personaRow(COLLIDING_ORPHAN);
      expect(persona.userId).toBe(BUSY_SUCCESSOR);
      expect(persona.slug).toBe('studio-3');
    });

    it('suffixes against a persona repaired earlier in the same run', async () => {
      const firstPersona = await personaRow(FIRST_SHARED_ORPHAN);
      const secondPersona = await personaRow(SECOND_SHARED_ORPHAN);
      expect(firstPersona.userId).toBe(BUSY_SUCCESSOR);
      expect(firstPersona.slug).toBe('shared');
      expect(secondPersona.userId).toBe(BUSY_SUCCESSOR);
      expect(secondPersona.slug).toBe('shared-2');
    });

    it('records every vacated address in the history table', async () => {
      expect(await historyRows()).toEqual([
        {
          previous_user_id: LATER_MEMBER,
          slug: 'archive',
          subprofile_id: MERGING_ORPHAN,
        },
        {
          previous_user_id: DEPARTED_CREATOR,
          slug: 'dormant',
          subprofile_id: INACTIVE_ONLY_ORPHAN,
        },
        {
          previous_user_id: DEPARTED_CREATOR,
          slug: 'lifted',
          subprofile_id: LIFTED_ORPHAN,
        },
        {
          previous_user_id: DEPARTED_CREATOR,
          slug: 'plain',
          subprofile_id: PLAIN_ORPHAN,
        },
        {
          previous_user_id: DEPARTED_CREATOR,
          slug: 'prefer',
          subprofile_id: ACTIVE_PREFERRED_ORPHAN,
        },
        {
          previous_user_id: DEPARTED_CREATOR,
          slug: 'shared',
          subprofile_id: FIRST_SHARED_ORPHAN,
        },
        {
          previous_user_id: EARLIEST_MEMBER,
          slug: 'shared',
          subprofile_id: SECOND_SHARED_ORPHAN,
        },
        {
          previous_user_id: DEPARTED_CREATOR,
          slug: 'studio',
          subprofile_id: COLLIDING_ORPHAN,
        },
        {
          previous_user_id: DEPARTED_CREATOR,
          slug: 'tied',
          subprofile_id: TIED_ORPHAN,
        },
      ]);
    });

    it('moves an Unlinked persona without recording its old address', async () => {
      const persona = await personaRow(UNLINKED_ORPHAN);
      expect(persona.userId).toBe(HEALTHY_CO_OWNER);
      expect(persona.slug).toBe('hidden-name');
      const unlinkedHistory = (await historyRows()).filter(
        (row) => row.subprofile_id === UNLINKED_ORPHAN,
      );
      expect(unlinkedHistory).toEqual([]);
    });

    it('prefers an active member over earlier suspended or deactivated ones', async () => {
      const persona = await personaRow(ACTIVE_PREFERRED_ORPHAN);
      expect(persona.userId).toBe(LATER_MEMBER);
    });

    it('falls back to the longest-standing member when none is active', async () => {
      const persona = await personaRow(INACTIVE_ONLY_ORPHAN);
      expect(persona.userId).toBe(SUSPENDED_MEMBER);
    });

    it('leaves a lifted takedown behind on a renamed slug', async () => {
      const persona = await personaRow(LIFTED_ORPHAN);
      expect(persona.userId).toBe(BUSY_SUCCESSOR);
      expect(persona.slug).toBe('lifted-2');
      expect(await moderationFor('lifted-2')).toBeNull();
    });

    it('copies a takedown to the renamed slug and keeps the original', async () => {
      const copied = await moderationFor('studio-3');
      expect(copied?.removedAt).toEqual(atHour(9));
      expect(copied?.reasonCode).toBe('spam');
      expect((await moderationFor('studio'))?.removedAt).toEqual(atHour(9));
    });

    it('merges a copied takedown into a row the new slug already has', async () => {
      const persona = await personaRow(MERGING_ORPHAN);
      expect(persona.slug).toBe('archive-3');
      const merged = await moderationFor('archive-3');
      expect(merged?.hiddenAt).toEqual(atHour(9));
      expect(merged?.removedAt).toEqual(atHour(10));
      const source = await moderationFor('archive');
      expect(source?.hiddenAt).toEqual(atHour(9));
      expect(source?.removedAt).toBeNull();
    });

    it('leaves a healthy persona and a memberless persona alone', async () => {
      const healthy = await personaRow(HEALTHY_PERSONA);
      expect(healthy.userId).toBe(HEALTHY_CREATOR);
      expect(healthy.slug).toBe('healthy');
      const memberless = await personaRow(MEMBERLESS_PERSONA);
      expect(memberless.userId).toBe(DEPARTED_CREATOR);
      expect(memberless.slug).toBe('memberless');
    });

    it('skips and lists a persona whose last member is erased mid-run', async () => {
      const persona = await personaRow(VANISHING_ORPHAN);
      expect(persona.userId).toBe(DEPARTED_CREATOR);
      expect(persona.slug).toBe('vanishing');
      const vanishingHistory = (await historyRows()).filter(
        (row) => row.subprofile_id === VANISHING_ORPHAN,
      );
      expect(vanishingHistory).toEqual([]);
    });

    it('reports the counts of what it changed', () => {
      expect(repairTally).toEqual({
        repairedPersonaCount: 10,
        historyRowCount: 9,
        suffixedSlugCount: 4,
        copiedModerationRowCount: 2,
        skippedPersonaIds: [VANISHING_ORPHAN],
      });
    });

    it('runs the same SQL through the migration and finds nothing left', async () => {
      const logSpy = jest
        .spyOn(console, 'log')
        .mockImplementation(() => undefined);
      // `migrationsTransactionMode: 'each'` wraps the migration in its own
      // transaction, as here.
      await queryRunner.startTransaction();
      await new RepairOrphanedPersonaCreators1821500400000().up(queryRunner);
      await queryRunner.commitTransaction();
      const loggedTally = String(logSpy.mock.calls[0]?.[0] ?? '');
      logSpy.mockRestore();
      expect(loggedTally).toContain('[RepairOrphanedPersonaCreators]');
      expect(loggedTally).toContain('"repairedPersonaCount": 0');
      expect(loggedTally).toContain('"skippedPersonaIds": []');
    });

    it('refuses to revert', async () => {
      await expect(
        new RepairOrphanedPersonaCreators1821500400000().down(),
      ).rejects.toThrow('Irreversible');
    });
  },
);

// Runs without a database, so the default suite still pins the one fact that
// keeps the migration and the post-deploy step identical.
describe('RepairOrphanedPersonaCreators1821500400000.up', () => {
  it('executes the shared repair SQL, then reads and logs its tally', async () => {
    const tally: RepairOrphanedPersonaCreatorsTally = {
      repairedPersonaCount: 1,
      historyRowCount: 1,
      suffixedSlugCount: 0,
      copiedModerationRowCount: 0,
      skippedPersonaIds: [],
    };
    const query = jest
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce([{ tally: JSON.stringify(tally) }]);
    const logSpy = jest
      .spyOn(console, 'log')
      .mockImplementation(() => undefined);

    await new RepairOrphanedPersonaCreators1821500400000().up({
      query,
    } as unknown as QueryRunner);

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]).toEqual([REPAIR_ORPHANED_PERSONA_CREATORS_SQL]);
    expect(String(logSpy.mock.calls[0]?.[0] ?? '')).toContain(
      '"repairedPersonaCount": 1',
    );
    logSpy.mockRestore();
  });
});
