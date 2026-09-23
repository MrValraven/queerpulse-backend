// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Records every nested address a persona has left behind when its creator
 * role moved to a co-owner.
 *
 * A persona nests under its creator's profile at
 * `/members/<creator-slug>/<persona-slug>`. When the creator leaves (or erases
 * their account) and the creator role passes to the longest-standing remaining
 * co-owner, `subprofiles.user_id` changes and the persona now lives under the
 * successor's profile, possibly with a suffixed slug. One row here keeps the
 * old pair `(previous_user_id, slug)` pointing at the persona, so the public
 * read can forward a visitor who follows an old link to the current address.
 *
 * The pair is unique: an old address forwards to exactly one persona, and a
 * later move that vacates the same pair again replaces the row. The public read
 * checks for a live persona at the same pair first, so a new persona created
 * at a vacated address always wins over the forward.
 *
 * Both foreign keys cascade. Deleting the previous creator's account drops
 * their forwards along with their profile, whose URL no longer resolves
 * anyway; deleting the persona drops every forward to it.
 *
 * `IDX_subprofile_address_history_subprofile_id` serves the subprofile
 * cascade. The unique pair already leads with `previous_user_id`, which
 * serves both the forward lookup and the user cascade.
 */
export class AddSubprofileAddressHistory1821500200000 implements MigrationInterface {
  name = 'AddSubprofileAddressHistory1821500200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "subprofile_address_history" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "previous_user_id" uuid NOT NULL,
        "slug" character varying NOT NULL,
        "subprofile_id" uuid NOT NULL,
        "moved_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_subprofile_address_history" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_subprofile_address_history_user_slug" UNIQUE ("previous_user_id", "slug"),
        CONSTRAINT "FK_subprofile_address_history_previous_user" FOREIGN KEY ("previous_user_id")
          REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_subprofile_address_history_subprofile" FOREIGN KEY ("subprofile_id")
          REFERENCES "subprofiles"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_subprofile_address_history_subprofile_id" ON "subprofile_address_history" ("subprofile_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "IDX_subprofile_address_history_subprofile_id"`,
    );
    await queryRunner.query(`DROP TABLE "subprofile_address_history"`);
  }
}
