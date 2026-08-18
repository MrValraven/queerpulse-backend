import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Gives the member-directory "What they do", "Profession" and "Languages"
 * filters real columns to read. Before this, all three were pure client-side
 * UI state in `MemberDirectoryFilterPage` — never sent to the API in live
 * mode (there was no backend field for them to filter on), and the demo-mode
 * values (`SLUG_FACETS` discipline/profession, randomly generated languages
 * in `memberDirectoryFilter.data.ts`) were entirely synthetic.
 *
 * Opt-in, empty by default, no backfill — same shape as
 * `discoverable_identities` (AddDiscoverableIdentities1782800770000), but
 * without that column's private/published split: a member's discipline,
 * profession and languages are professional-identity facts in the same
 * spirit as `tags` (skills) — set once, visible whenever the card is, not
 * gated behind a separate publish step. See `src/profiles/professions.ts`
 * and `src/profiles/languages.ts` for the vocabularies these columns are
 * range-checked against at the DTO layer.
 *
 * `discipline`/`profession` are both arrays (not single values): real member
 * bios already describe multiple roles ("Dancer, model & venture builder"),
 * so a single-select column would have under-fit the data from day one.
 *
 * No GIN index, for the same reason `discoverable_identities` skipped one:
 * every existing row starts empty and stays sparse until members opt in, so
 * a sequential scan is the cheaper plan until real usage says otherwise.
 */
export class AddProfileDisciplineProfessionLanguages1791000000000 implements MigrationInterface {
  name = 'AddProfileDisciplineProfessionLanguages1791000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "profiles" ADD "discipline" text array NOT NULL DEFAULT '{}'`,
    );
    await queryRunner.query(
      `ALTER TABLE "profiles" ADD "profession" text array NOT NULL DEFAULT '{}'`,
    );
    await queryRunner.query(
      `ALTER TABLE "profiles" ADD "languages" text array NOT NULL DEFAULT '{}'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "profiles" DROP COLUMN "languages"`);
    await queryRunner.query(`ALTER TABLE "profiles" DROP COLUMN "profession"`);
    await queryRunner.query(`ALTER TABLE "profiles" DROP COLUMN "discipline"`);
  }
}
