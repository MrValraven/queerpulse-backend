import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * One additive column + one new enum type on `conversation_participants`
 * (PRD-349, mentions-only mute):
 *
 * `mute_mode`: a SECOND axis on top of the pre-existing `muted`/`muted_until`
 * columns, never a loose boolean that could contradict them. See
 * `ConversationParticipant.muteMode`'s own doc for exactly how the two
 * interact (the short version: `'mentionsOnly'` overrides push eligibility
 * for the plain "new message" push independent of `muted`'s own value, and
 * stands as its own distinct row-menu choice alongside the 8-hour/1-week/
 * Always mute durations).
 *
 * `'all'` is the default and what every pre-PRD-349 row reads as: the
 * ordinary mute the two existing columns already fully describe. Nullable is
 * unnecessary (unlike the timestamp preference columns on this table): there
 * is no "unset" state to represent, so every row gets a real value up front
 * via `DEFAULT 'all'` rather than defaulting the column to NULL and having
 * every reader fall back in application code.
 */
export class AddConversationParticipantMuteMode1820800000000 implements MigrationInterface {
  name = 'AddConversationParticipantMuteMode1820800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "conversation_participants_mute_mode_enum" AS ENUM ('all', 'mentionsOnly')
    `);
    await queryRunner.query(`
      ALTER TABLE "conversation_participants"
        ADD COLUMN "mute_mode" "conversation_participants_mute_mode_enum" NOT NULL DEFAULT 'all'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "conversation_participants"
        DROP COLUMN "mute_mode"
    `);
    await queryRunner.query(`
      DROP TYPE "conversation_participants_mute_mode_enum"
    `);
  }
}
