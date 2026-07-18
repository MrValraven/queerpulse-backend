import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the `handles` registry — the single source of truth for the ONE global
 * username namespace (design plan PART C / UC2). Every main-profile username and
 * every published unlinked-subprofile handle occupies exactly one row here, so
 * `name` (the PK) enforces global uniqueness across both owner kinds at once.
 *
 * A CHECK constraint keeps each row internally consistent: a `profile` row
 * carries a `user_id` (and no `subprofile_id`); a `subprofile` row carries a
 * `subprofile_id` (and no `user_id`). Both FKs cascade so deleting a user or a
 * subprofile frees its handle. Enum/column names match the `Handle` entity and
 * `HandlesService` so the API (Task C1/C2) and the frontend (Task C3) line up.
 *
 * The `up()` also BACKFILLS existing profile slugs into the registry so live
 * usernames are represented from day one. That backfill is INCOMPLETE by
 * construction — see the note on the INSERT below; `BackfillHandleStragglers`
 * (1782800670000) finishes the job and must stay ordered after this migration.
 */
export class AddHandles1782800660000 implements MigrationInterface {
  name = 'AddHandles1782800660000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // --- enum ----------------------------------------------------------------
    await queryRunner.query(`
      CREATE TYPE "handles_owner_kind_enum" AS ENUM ('profile', 'subprofile')
    `);

    // --- table ---------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "handles" (
        "name" character varying NOT NULL,
        "owner_kind" "handles_owner_kind_enum" NOT NULL,
        "user_id" uuid,
        "subprofile_id" uuid,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_handles" PRIMARY KEY ("name"),
        CONSTRAINT "CHK_handles_owner" CHECK (
          ("owner_kind" = 'profile' AND "user_id" IS NOT NULL AND "subprofile_id" IS NULL)
          OR
          ("owner_kind" = 'subprofile' AND "subprofile_id" IS NOT NULL AND "user_id" IS NULL)
        )
      )
    `);

    // --- indexes -------------------------------------------------------------
    await queryRunner.query(
      `CREATE INDEX "IDX_handles_user_id" ON "handles" ("user_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_handles_subprofile_id" ON "handles" ("subprofile_id")`,
    );

    // --- foreign keys --------------------------------------------------------
    await queryRunner.query(`
      ALTER TABLE "handles" ADD CONSTRAINT "FK_handles_user_id"
        FOREIGN KEY ("user_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "handles" ADD CONSTRAINT "FK_handles_subprofile_id"
        FOREIGN KEY ("subprofile_id") REFERENCES "subprofiles"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);

    // --- backfill ------------------------------------------------------------
    // Seed the registry from existing profile usernames. The regex guard skips
    // slugs that violate HANDLE_RE (too short/long or otherwise out of format),
    // and ON CONFLICT DO NOTHING guards the rare case where two profile slugs
    // fold to the same lowercased name.
    //
    // Both skips leave a live /members/<slug> without a registry row.
    // `BackfillHandleStragglers` (1782800670000) reserves the remainder and
    // fails loudly on the collisions it cannot resolve, so the invariant "every
    // profile owns its own name" holds by the end of the migration run. This
    // statement is left as-authored because it has already been applied to
    // existing databases.
    await queryRunner.query(`
      INSERT INTO "handles" ("name", "owner_kind", "user_id")
      SELECT lower("slug"), 'profile', "user_id"
      FROM "profiles"
      WHERE lower("slug") ~ '^[a-z0-9][a-z0-9-]{2,29}$'
      ON CONFLICT ("name") DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "handles" DROP CONSTRAINT "FK_handles_subprofile_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "handles" DROP CONSTRAINT "FK_handles_user_id"`,
    );
    await queryRunner.query(`DROP INDEX "IDX_handles_subprofile_id"`);
    await queryRunner.query(`DROP INDEX "IDX_handles_user_id"`);
    await queryRunner.query(`DROP TABLE "handles"`);
    await queryRunner.query(`DROP TYPE "handles_owner_kind_enum"`);
  }
}
