// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { randomUUID } from 'crypto';
import { MigrationInterface, QueryRunner } from 'typeorm';
import { QUIZSHOW_TEMPLATE_SEEDS_1837900000000 } from './data/quizshow-templates-1837900000000.seed';

/**
 * Pulse Live (code id `quizshow`) templates: `quizshow_templates` holds the
 * staff-made quizzes that hosts copy once staff publish them, with the card
 * text hosts see and the staff notes. Each template owns one quiz through
 * `quizshow_quizzes.template_id`, so a quiz now has exactly one of three
 * scopes, an event, a member who owns a game, or a template
 * (`CHK_quizshow_quizzes_scope`). A host copy records its template in
 * `source_template_id`.
 *
 * Retention rules the new keys carry:
 * - a template lives until staff delete it; deleting it cascades its quiz,
 *   rounds and questions, and host copies keep their rows with
 *   `source_template_id` set null;
 * - account erasure sets the quiz author ids and the template publisher id
 *   null, and event deletion or game owner deletion never reaches a template.
 *
 * The five retired starter packs are seeded from the frozen data in
 * `./data/quizshow-templates-1837900000000.seed.ts` as drafts, because
 * publishing is the fact-check step. The backfill sets `source_template_id`
 * from the retired `starter_pack_key` for environments where the quizshow
 * migrations already ran, then the key column goes.
 *
 * `down` deletes exactly the five seeds and leaves staff-made templates for
 * the maintainer to decide on, so it fails while any remain.
 *
 * The feature has not launched, so the quizshow tables are tiny and the index
 * builds inside the migration transaction.
 */
export class AddQuizshowTemplates1837900000000 implements MigrationInterface {
  name = 'AddQuizshowTemplates1837900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "quizshow_templates" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "card_title_en" character varying(120) NOT NULL,
        "card_title_pt" character varying(120) NOT NULL,
        "card_description_en" character varying(300) NOT NULL,
        "card_description_pt" character varying(300) NOT NULL,
        "staff_notes" character varying(20000) NOT NULL DEFAULT '',
        "published_at" TIMESTAMP(3) WITH TIME ZONE,
        "published_by_user_id" uuid,
        "created_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_quizshow_templates" PRIMARY KEY ("id"),
        CONSTRAINT "FK_quizshow_templates_published_by" FOREIGN KEY ("published_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION
      )
    `);

    await queryRunner.query(
      `ALTER TABLE "quizshow_quizzes" ADD "template_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "quizshow_quizzes" ADD CONSTRAINT "UQ_quizshow_quizzes_template_id" UNIQUE ("template_id")`,
    );
    await queryRunner.query(
      `ALTER TABLE "quizshow_quizzes" ADD CONSTRAINT "FK_quizshow_quizzes_template" FOREIGN KEY ("template_id") REFERENCES "quizshow_templates"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );

    await queryRunner.query(
      `ALTER TABLE "quizshow_quizzes" DROP CONSTRAINT "CHK_quizshow_quizzes_scope"`,
    );
    await queryRunner.query(
      `ALTER TABLE "quizshow_quizzes" ADD CONSTRAINT "CHK_quizshow_quizzes_scope" CHECK (num_nonnulls("event_id", "owner_user_id", "template_id") = 1)`,
    );

    await queryRunner.query(
      `ALTER TABLE "quizshow_quizzes" ADD "source_template_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "quizshow_quizzes" ADD CONSTRAINT "FK_quizshow_quizzes_source_template" FOREIGN KEY ("source_template_id") REFERENCES "quizshow_templates"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    // Host copies of one template: serves the template delete, which sets
    // their `source_template_id` null.
    await queryRunner.query(
      `CREATE INDEX "IDX_quizshow_quizzes_source_template_id" ON "quizshow_quizzes" ("source_template_id")`,
    );

    for (const seed of QUIZSHOW_TEMPLATE_SEEDS_1837900000000) {
      await queryRunner.query(
        `INSERT INTO "quizshow_templates"
           ("id", "card_title_en", "card_title_pt", "card_description_en", "card_description_pt", "staff_notes", "published_at")
         VALUES ($1, $2, $3, $4, $5, $6, NULL)`,
        [
          seed.id,
          seed.cardTitle.en,
          seed.cardTitle.pt,
          seed.cardDescription.en,
          seed.cardDescription.pt,
          seed.staffNotes,
        ],
      );

      const quizId = randomUUID();
      await queryRunner.query(
        `INSERT INTO "quizshow_quizzes"
           ("id", "template_id", "title", "languages", "screen_language", "updated_at")
         VALUES ($1, $2, $3, $4, $5, now())`,
        [
          quizId,
          seed.id,
          seed.quiz.title,
          seed.quiz.languages,
          seed.quiz.screenLanguage,
        ],
      );

      for (const [roundIndex, round] of seed.quiz.rounds.entries()) {
        const roundId = randomUUID();
        await queryRunner.query(
          `INSERT INTO "quizshow_rounds"
             ("id", "quiz_id", "position", "kind", "title_en", "title_pt", "content_label", "settings")
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
          [
            roundId,
            quizId,
            roundIndex,
            round.kind,
            round.title.en,
            round.title.pt,
            round.contentLabel,
            JSON.stringify(round.settings),
          ],
        );

        for (const [questionIndex, rawQuestion] of round.questions.entries()) {
          const question = rawQuestion as unknown as SeedQuestion;
          await queryRunner.query(
            `INSERT INTO "quizshow_questions"
               ("round_id", "position", "type", "prompt_en", "prompt_pt", "media_ref", "options", "answer", "accepted_answers", "time_limit_seconds", "points")
             VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11)`,
            [
              roundId,
              questionIndex,
              question.type,
              question.prompt.en,
              question.prompt.pt,
              question.mediaRef,
              JSON.stringify(question.options),
              question.answer === null ? null : JSON.stringify(question.answer),
              JSON.stringify(question.acceptedAnswers),
              question.timeLimitSeconds,
              question.points,
            ],
          );
        }
      }
    }

    // A key outside the five seeded packs keeps `source_template_id` null.
    await queryRunner.query(
      `UPDATE "quizshow_quizzes" AS "quiz" SET "source_template_id" = "seed"."template_id"
       FROM (SELECT unnest($1::text[]) AS "pack_key", unnest($2::uuid[]) AS "template_id") AS "seed"
       WHERE "quiz"."starter_pack_key" = "seed"."pack_key"`,
      [seedPackKeys(), seedTemplateIds()],
    );
    await queryRunner.query(
      `ALTER TABLE "quizshow_quizzes" DROP COLUMN "starter_pack_key"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "quizshow_quizzes" ADD "starter_pack_key" character varying(40)`,
    );
    await queryRunner.query(
      `UPDATE "quizshow_quizzes" AS "quiz" SET "starter_pack_key" = "seed"."pack_key"
       FROM (SELECT unnest($1::text[]) AS "pack_key", unnest($2::uuid[]) AS "template_id") AS "seed"
       WHERE "quiz"."source_template_id" = "seed"."template_id"`,
      [seedPackKeys(), seedTemplateIds()],
    );

    // Exactly the five seeds go, with their quizzes, rounds and questions.
    await queryRunner.query(
      `DELETE FROM "quizshow_templates" WHERE "id" = ANY($1::uuid[])`,
      [seedTemplateIds()],
    );

    await queryRunner.query(
      `DROP INDEX "IDX_quizshow_quizzes_source_template_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "quizshow_quizzes" DROP CONSTRAINT "FK_quizshow_quizzes_source_template"`,
    );
    await queryRunner.query(
      `ALTER TABLE "quizshow_quizzes" DROP COLUMN "source_template_id"`,
    );

    // Restoring the two-scope check only succeeds while no staff-made
    // template quiz remains: its event and owner are null, so the check
    // correctly fails and the transaction rolls the whole revert back.
    // Staff-made templates are left for the maintainer to decide on.
    await queryRunner.query(
      `ALTER TABLE "quizshow_quizzes" DROP CONSTRAINT "CHK_quizshow_quizzes_scope"`,
    );
    await queryRunner.query(
      `ALTER TABLE "quizshow_quizzes" ADD CONSTRAINT "CHK_quizshow_quizzes_scope" CHECK (num_nonnulls("event_id", "owner_user_id") = 1)`,
    );

    await queryRunner.query(
      `ALTER TABLE "quizshow_quizzes" DROP CONSTRAINT "UQ_quizshow_quizzes_template_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "quizshow_quizzes" DROP CONSTRAINT "FK_quizshow_quizzes_template"`,
    );
    await queryRunner.query(
      `ALTER TABLE "quizshow_quizzes" DROP COLUMN "template_id"`,
    );

    await queryRunner.query(`DROP TABLE "quizshow_templates"`);
  }
}

/** The question fields the frozen seed holds for every question. */
interface SeedQuestion {
  type: string;
  prompt: { en: string; pt: string };
  options: unknown[];
  answer: Record<string, unknown> | null;
  acceptedAnswers: string[];
  mediaRef: string | null;
  timeLimitSeconds: number | null;
  points: number;
}

function seedPackKeys(): string[] {
  return QUIZSHOW_TEMPLATE_SEEDS_1837900000000.map((seed) => seed.packKey);
}

function seedTemplateIds(): string[] {
  return QUIZSHOW_TEMPLATE_SEEDS_1837900000000.map((seed) => seed.id);
}
