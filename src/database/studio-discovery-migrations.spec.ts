// Lives in `src/database`, outside `src/migrations`: the TypeORM CLI and
// `DatabaseModule` require every `src/migrations/*.ts` file.
import { QueryRunner } from 'typeorm';
import { AddStudioDiscovery1831800000000 } from '../migrations/1831800000000-AddStudioDiscovery';
import { AddStudioCreditNotificationTypes1831800100000 } from '../migrations/1831800100000-AddStudioCreditNotificationTypes';

function capturingRunner(): { runner: QueryRunner; statements: string[] } {
  const statements: string[] = [];
  const runner = {
    query: (sql: string) => {
      statements.push(sql.replace(/\s+/g, ' ').trim());
      return Promise.resolve();
    },
  } as unknown as QueryRunner;
  return { runner, statements };
}

describe('AddStudioDiscovery1831800000000', () => {
  it('creates the three types, the four tables and the two release columns', async () => {
    const { runner, statements } = capturingRunner();
    await new AddStudioDiscovery1831800000000().up(runner);
    const sql = statements.join('\n');

    expect(sql).toContain(
      `CREATE TYPE "studio_curated_picks_shelf_enum" AS ENUM ('featured', 'staff_picks', 'new_this_week')`,
    );
    expect(sql).toContain(
      `CREATE TYPE "studio_scenes_status_enum" AS ENUM ('active', 'archived')`,
    );
    expect(sql).toContain(
      `CREATE TYPE "studio_persona_credits_status_enum" AS ENUM ('pending', 'accepted', 'declined')`,
    );
    for (const table of [
      'studio_scenes',
      'studio_curated_picks',
      'studio_scene_events',
      'studio_persona_credits',
    ]) {
      expect(sql).toContain(`CREATE TABLE "${table}"`);
    }
    expect(sql).toContain(
      `ALTER TABLE "studio_releases" ADD "mood" character varying(40), ADD "scene_id" uuid`,
    );
  });

  it('cascades both persona keys of a credit on delete and on update', async () => {
    const { runner, statements } = capturingRunner();
    await new AddStudioDiscovery1831800000000().up(runner);
    const sql = statements.join('\n');

    expect(sql).toContain(
      `CONSTRAINT "FK_studio_persona_credits_subprofile" FOREIGN KEY ("subprofile_id") REFERENCES "subprofiles"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
    );
    expect(sql).toContain(
      `CONSTRAINT "FK_studio_persona_credits_requested_by_subprofile" FOREIGN KEY ("requested_by_subprofile_id") REFERENCES "subprofiles"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
    );
  });

  // An unlink gives the persona's releases and tracks fresh ids with one
  // `UPDATE ... SET "id"` each; a key with no update action would refuse it.
  it('cascades the track and release keys on update so an unlink re-key succeeds', async () => {
    const { runner, statements } = capturingRunner();
    await new AddStudioDiscovery1831800000000().up(runner);
    const sql = statements.join('\n');

    expect(sql).toContain(
      `CONSTRAINT "FK_studio_persona_credits_track" FOREIGN KEY ("track_id") REFERENCES "studio_tracks"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
    );
    expect(sql).toContain(
      `CONSTRAINT "FK_studio_curated_picks_release" FOREIGN KEY ("release_id") REFERENCES "studio_releases"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
    );
    expect(sql).toContain(
      `CONSTRAINT "FK_studio_releases_scene" FOREIGN KEY ("scene_id") REFERENCES "studio_scenes"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
  });

  it('keeps shelf positions unique and deferrable and credits unique per track, persona and role', async () => {
    const { runner, statements } = capturingRunner();
    await new AddStudioDiscovery1831800000000().up(runner);
    const sql = statements.join('\n');

    expect(sql).toContain(
      `CONSTRAINT "UQ_studio_curated_picks_shelf_position" UNIQUE ("shelf", "position") DEFERRABLE INITIALLY IMMEDIATE`,
    );
    expect(sql).toContain(
      `CONSTRAINT "UQ_studio_curated_picks_shelf_release" UNIQUE ("shelf", "release_id")`,
    );
    expect(sql).toContain(
      `CONSTRAINT "UQ_studio_persona_credits_track_subprofile_role" UNIQUE ("track_id", "subprofile_id", "role")`,
    );
    expect(sql).toContain(
      `CONSTRAINT "PK_studio_scene_events" PRIMARY KEY ("scene_id", "event_id")`,
    );
  });

  it('builds the mood and scene indexes in feed order on published rows', async () => {
    const { runner, statements } = capturingRunner();
    await new AddStudioDiscovery1831800000000().up(runner);

    expect(statements).toContain(
      `CREATE INDEX "IDX_studio_releases_mood_published_at" ON "studio_releases" ("mood", "published_at" DESC, "id" DESC) WHERE "status" = 'published'`,
    );
    expect(statements).toContain(
      `CREATE INDEX "IDX_studio_releases_scene_published_at" ON "studio_releases" ("scene_id", "published_at" DESC, "id" DESC) WHERE "status" = 'published'`,
    );
  });

  // Erasure sets `requested_by_user_id` null through its foreign key, which
  // scans the column without this index.
  it('indexes the requesting user of a credit and drops that index in down', async () => {
    const upRun = capturingRunner();
    await new AddStudioDiscovery1831800000000().up(upRun.runner);
    expect(upRun.statements).toContain(
      `CREATE INDEX "IDX_studio_persona_credits_requested_by_user_id" ON "studio_persona_credits" ("requested_by_user_id")`,
    );

    const downRun = capturingRunner();
    await new AddStudioDiscovery1831800000000().down(downRun.runner);
    const dropIndexAt = downRun.statements.indexOf(
      'DROP INDEX "IDX_studio_persona_credits_requested_by_user_id"',
    );
    expect(dropIndexAt).toBeGreaterThanOrEqual(0);
    expect(dropIndexAt).toBeLessThan(
      downRun.statements.indexOf('DROP TABLE "studio_persona_credits"'),
    );
  });

  it('drops everything it created in down, the types last', async () => {
    const { runner, statements } = capturingRunner();
    await new AddStudioDiscovery1831800000000().down(runner);

    expect(statements.slice(-3)).toEqual([
      'DROP TYPE "studio_persona_credits_status_enum"',
      'DROP TYPE "studio_scenes_status_enum"',
      'DROP TYPE "studio_curated_picks_shelf_enum"',
    ]);
    for (const table of [
      'studio_persona_credits',
      'studio_scene_events',
      'studio_curated_picks',
      'studio_scenes',
    ]) {
      expect(statements).toContain(`DROP TABLE "${table}"`);
    }
    expect(statements).toContain(
      'ALTER TABLE "studio_releases" DROP COLUMN "scene_id"',
    );
    expect(statements).toContain(
      'ALTER TABLE "studio_releases" DROP COLUMN "mood"',
    );
  });
});

describe('AddStudioCreditNotificationTypes1831800100000', () => {
  it('adds both labels outside a transaction', async () => {
    const migration = new AddStudioCreditNotificationTypes1831800100000();
    const { runner, statements } = capturingRunner();
    await migration.up(runner);

    expect(migration.transaction).toBe(false);
    expect(statements).toEqual([
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'studio_credit_requested'`,
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'studio_credit_accepted'`,
    ]);
  });

  it('refuses to run down', async () => {
    await expect(
      new AddStudioCreditNotificationTypes1831800100000().down(),
    ).rejects.toThrow('Irreversible');
  });
});
