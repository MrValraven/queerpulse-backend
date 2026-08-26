// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The house rule a community ban rests on, snapshotted onto the ban row
 * (`rule_index`, `rule_version`, `rule_text`).
 *
 * `communities.rules` is a plain `text[]` and `communities.rules_version` is
 * bumped whenever an owner edits it. An index on its own is therefore unstable:
 * rule 3 today can be rule 5, or a different rule entirely, after one edit, and
 * a citation that silently changes meaning is worse than no citation. So all
 * three are stored:
 *
 *  - `rule_index`   which entry in `communities.rules` was cited, 0-based.
 *  - `rule_version` the `communities.rules_version` current at the moment of
 *                   the action, so a reader can tell whether the rules have
 *                   been rewritten since.
 *  - `rule_text`    the rule's exact wording at that moment. This is what the
 *                   ban list and the member's notification render, so the
 *                   record still reads correctly after a rewrite.
 *
 * All three nullable together: citing a rule is optional, and a community with
 * no rules has nothing to cite. Nothing is backfilled, because no existing ban
 * cited anything and inventing a citation for one would be a falsified record.
 *
 * No index: these columns are read alongside the row they sit on and are never
 * a search key.
 */
export class AddCommunityBanRuleCitation1794911000000 implements MigrationInterface {
  name = 'AddCommunityBanRuleCitation1794911000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "community_bans"
        ADD COLUMN "rule_index" integer,
        ADD COLUMN "rule_version" integer,
        ADD COLUMN "rule_text" text
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "community_bans"
        DROP COLUMN "rule_text",
        DROP COLUMN "rule_version",
        DROP COLUMN "rule_index"
    `);
  }
}
