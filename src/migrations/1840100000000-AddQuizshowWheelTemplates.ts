// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { randomUUID } from 'crypto';
import { MigrationInterface, QueryRunner } from 'typeorm';
import { QUIZSHOW_WHEEL_TEMPLATE_SEEDS_1840100000000 } from './data/quizshow-wheel-templates-1840100000000.seed';

/**
 * Pulse Live (code id `quizshow`) wheel templates: five staff templates built
 * around the spinning wheel, seeded from the frozen data in
 * `./data/quizshow-wheel-templates-1840100000000.seed.ts`. Three pick a round
 * (Pop divas, Queer TV night, Sapphic night) and two pick a question from a
 * category (Queer anthems, Screen icons). They land as drafts, because
 * publishing is the fact-check step: every question's source is in the
 * template's staff notes.
 *
 * Data only, no schema change. Every row uses the round kind `wheel`, which
 * AddQuizshowWheel1840000000000 adds in its own committed, non-transactional
 * migration (`migrationsTransactionMode: 'each'`), so this one runs inside
 * the usual transaction.
 *
 * `down` deletes exactly these five templates; the delete cascades to their
 * quizzes, rounds and questions, and any host copy keeps its rows with
 * `source_template_id` set null.
 */
export class AddQuizshowWheelTemplates1840100000000 implements MigrationInterface {
  name = 'AddQuizshowWheelTemplates1840100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const seed of QUIZSHOW_WHEEL_TEMPLATE_SEEDS_1840100000000) {
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
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM "quizshow_templates" WHERE "id" = ANY($1::uuid[])`,
      [QUIZSHOW_WHEEL_TEMPLATE_SEEDS_1840100000000.map((seed) => seed.id)],
    );
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
