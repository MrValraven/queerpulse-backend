// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `nominee_user_id` and `nominee_contact` to `changemaker_nomination`.
 *
 * WHY. Until now a nomination reached the admin queue as a bare name plus a
 * sentence, with nothing a reviewer could check it against. Two people share a
 * first name, a stage name is not a legal name, and "runs the Tuesday support
 * group" is not something you can look up. A reviewer who wanted to open a
 * story had no way to reach the nominee or read more about their work, so the
 * decision came down to whether the reviewer happened to already know them.
 *
 * TWO COLUMNS, BECAUSE THEY ARE TWO DIFFERENT FACTS. `nominee_user_id` says
 * "this nominee is already a member here" and resolves to a real profile the
 * reviewer can open. `nominee_contact` is free text for everyone who is not:
 * an Instagram handle, a website, an email. Collapsing them into one text
 * column would mean re-parsing a typed "@handle" against the member table on
 * every read, and would lose the distinction between a member who can be
 * looked up and a string someone typed.
 *
 * NO FOREIGN KEY, matching `nominator_id` on the same table (and the way
 * `CommissionInterest` denormalizes its target): this module never registers
 * `users`, and a nomination should outlive the account of someone who later
 * erases their profile. A dangling id simply resolves to no `MemberRef`, which
 * the admin row already renders as "A former member".
 *
 * Both nullable. Every existing row predates the fields, and both stay
 * optional on the form going forward, so the page's promise that "a name and a
 * sentence is enough to start" survives.
 *
 * Purely transactional DDL: two `ALTER TABLE ... ADD` and a plain
 * `CREATE INDEX` (never `CONCURRENTLY`), so this runs inside the migration
 * transaction like any other.
 */
export class AddChangemakerNominationContact1795750000000 implements MigrationInterface {
  name = 'AddChangemakerNominationContact1795750000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "changemaker_nomination" ADD "nominee_user_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "changemaker_nomination" ADD "nominee_contact" character varying(200)`,
    );
    // Read path only: the admin queue batches its member lookups by
    // `nominee_user_id` across a page of rows.
    await queryRunner.query(
      `CREATE INDEX "IDX_changemaker_nomination_nominee_user_id" ON "changemaker_nomination" ("nominee_user_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "IDX_changemaker_nomination_nominee_user_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "changemaker_nomination" DROP COLUMN "nominee_contact"`,
    );
    await queryRunner.query(
      `ALTER TABLE "changemaker_nomination" DROP COLUMN "nominee_user_id"`,
    );
  }
}
