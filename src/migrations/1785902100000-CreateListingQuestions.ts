import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `listing_questions` — the Q&A conversation thread (item #17) shown in
 * the admin drawer via `GET /listings/admin/:ref/history` (see
 * `ListingQuestion` entity for the full field-by-field rationale). A row is
 * written by `ListingsService.askQuestion` alongside the existing DM
 * delivery to the submitter; `answer`/`answered_at` are filled in by the
 * listing owner via the owner-gated `POST /listings/:ref/questions/:id/answer`.
 *
 * `listing_id` follows the same deliberate no-FK-to-`listings` convention as
 * `listing_moderation_events.listing_id` (see that migration's doc comment).
 * `asked_by` gets a foreign key to `users(id)` `ON DELETE SET NULL`, same
 * rationale as that table's `actor_id`.
 */
export class CreateListingQuestions1785902100000 implements MigrationInterface {
  name = 'CreateListingQuestions1785902100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "listing_questions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "listing_id" uuid NOT NULL,
        "asked_by" uuid,
        "body" text NOT NULL,
        "answer" text,
        "answered_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_listing_questions" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "IDX_listing_questions_listing_id" ON "listing_questions" ("listing_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_listing_questions_asked_by" ON "listing_questions" ("asked_by")`,
    );

    await queryRunner.query(`
      ALTER TABLE "listing_questions" ADD CONSTRAINT "FK_listing_questions_asked_by"
        FOREIGN KEY ("asked_by") REFERENCES "users"("id")
        ON DELETE SET NULL ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "listing_questions" DROP CONSTRAINT "FK_listing_questions_asked_by"`,
    );
    await queryRunner.query(`DROP INDEX "IDX_listing_questions_asked_by"`);
    await queryRunner.query(`DROP INDEX "IDX_listing_questions_listing_id"`);
    await queryRunner.query(`DROP TABLE "listing_questions"`);
  }
}
