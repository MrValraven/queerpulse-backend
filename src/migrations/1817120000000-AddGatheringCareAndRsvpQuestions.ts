// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Gives a gathering the care layer the create-gathering v2 wizard asks for,
 * and gives an RSVP somewhere to keep the answers to its new questions.
 *
 * THE PROBLEM. The redesigned wizard asks for themes, content notes, house
 * rules, a cost kind, when RSVPs close, and which optional questions the RSVP
 * details modal should ask. None of it had a column, so all of it would have
 * been discarded on publish, which is the LOC-04 failure over again.
 *
 * WHAT LANDS HERE, on `events`: `themes` and `content_notes` (NOT NULL jsonb
 * arrays, empty by default), `house_rules`, `cost_kind`, `rsvp_cutoff` and
 * `custom_rsvp_question` (nullable varchar), and `rsvp_questions` (a complete
 * NOT NULL jsonb map). On `event_rsvps`: `pronouns` and
 * `custom_answer` (nullable varchar). Every vocabulary and length is declared
 * in `src/events/gathering-extras.ts`.
 *
 * THE BACKFILL is one statement. `rsvp_questions` defaults to asking nothing,
 * which is right for a gathering created from now on. Every gathering that
 * already exists was published under a modal that always asked dietary and
 * access needs, so those rows are set to keep asking exactly that. Nothing
 * else is backfilled: an existing gathering has no themes, no notes, no cutoff
 * and no stated cost kind, and inventing any of them would put words in a
 * host's mouth.
 *
 * TRANSACTIONAL. Plain `ADD COLUMN`s and one `UPDATE`, no enum extension and
 * no concurrent index, so the columns and the backfill land together or not
 * at all.
 */
export class AddGatheringCareAndRsvpQuestions1817120000000 implements MigrationInterface {
  name = 'AddGatheringCareAndRsvpQuestions1817120000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "events"
        ADD COLUMN "themes" jsonb NOT NULL DEFAULT '[]',
        ADD COLUMN "content_notes" jsonb NOT NULL DEFAULT '[]',
        ADD COLUMN "house_rules" character varying(160),
        ADD COLUMN "cost_kind" character varying(20),
        ADD COLUMN "rsvp_cutoff" character varying(24),
        ADD COLUMN "rsvp_questions" jsonb NOT NULL DEFAULT '{"dietary":false,"pronouns":false,"access":false}',
        ADD COLUMN "custom_rsvp_question" character varying(120)
    `);

    // Every row here predates the column, so every row keeps the questions its
    // RSVP modal already asked. Rows written after this migration take the
    // column default, or whatever the wizard sends.
    await queryRunner.query(
      `UPDATE "events" SET "rsvp_questions" = '{"dietary":true,"pronouns":false,"access":true}'`,
    );

    await queryRunner.query(`
      ALTER TABLE "event_rsvps"
        ADD COLUMN "pronouns" character varying(60),
        ADD COLUMN "custom_answer" character varying(500)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "event_rsvps"
        DROP COLUMN "custom_answer",
        DROP COLUMN "pronouns"
    `);
    await queryRunner.query(`
      ALTER TABLE "events"
        DROP COLUMN "custom_rsvp_question",
        DROP COLUMN "rsvp_questions",
        DROP COLUMN "rsvp_cutoff",
        DROP COLUMN "cost_kind",
        DROP COLUMN "house_rules",
        DROP COLUMN "content_notes",
        DROP COLUMN "themes"
    `);
  }
}
