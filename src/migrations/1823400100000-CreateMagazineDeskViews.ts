// Applied at backend boot while pending: `ensureDatabaseSchema` (called from
// `src/main.ts`) runs every pending migration at startup unless
// `AUTO_RUN_MIGRATIONS=false` is set. To apply it by hand instead, set that
// flag, check `pnpm run typeorm migration:show`, then `pnpm run migration:run`.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-editor saved desk views (`MagazineDeskView`,
 * `entities/magazine-desk-view.entity.ts`). Each row is a named snapshot of
 * the editor desk's URL state, private to its owner.
 *
 * `owner_id` cascades on user delete: a saved view is personal workspace
 * state, and account erasure deletes the user row and relies on the cascade.
 * The (owner, name) unique constraint backs the service's 409 on a duplicate
 * name, including the race two tabs can run. The (owner, position) index
 * serves the one read the desk makes: the owner's list in order.
 */
export class CreateMagazineDeskViews1823400100000 implements MigrationInterface {
  name = 'CreateMagazineDeskViews1823400100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "magazine_desk_view" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "owner_id" uuid NOT NULL,
        "name" character varying(60) NOT NULL,
        "query" jsonb NOT NULL,
        "position" integer NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_magazine_desk_view" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_magazine_desk_view_owner_name" UNIQUE ("owner_id", "name"),
        CONSTRAINT "FK_magazine_desk_view_owner" FOREIGN KEY ("owner_id")
          REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_magazine_desk_view_owner_position" ON "magazine_desk_view" ("owner_id", "position")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "IDX_magazine_desk_view_owner_position"`,
    );
    await queryRunner.query(`DROP TABLE "magazine_desk_view"`);
  }
}
