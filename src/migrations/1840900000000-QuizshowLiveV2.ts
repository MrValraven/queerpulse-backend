// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The second tier and third tier team keys, in the auto-assign order of
 * `QUIZSHOW_TEAM_COLOR_KEYS`. Frozen here so later contract edits never
 * change what this migration adds.
 */
const NEW_TEAM_COLOR_KEYS = [
  'circle_2',
  'triangle_2',
  'square_2',
  'diamond_2',
  'star_2',
  'hexagon_2',
  'heart_2',
  'moon_2',
  'circle_3',
  'triangle_3',
  'square_3',
  'diamond_3',
  'star_3',
  'hexagon_3',
  'heart_3',
  'moon_3',
] as const;

/** One seeded template question whose tolerance and unit step 6 sets. */
interface SeededClosestRow {
  templateId: string;
  roundPosition: number;
  questionPosition: number;
  /** The seeded answer value; a question staff changed since is left alone. */
  value: number;
  toleranceMode: 'exact' | 'percent';
  toleranceAmount: number;
  unitEn: string;
  unitPt: string;
}

const POP_DIVAS_TEMPLATE_ID = 'a7e3b1c0-5eed-4000-8000-000000000007';
const QUEER_TV_NIGHT_TEMPLATE_ID = 'a7e3b1c0-5eed-4000-8000-000000000009';
const SCREEN_ICONS_TEMPLATE_ID = 'a7e3b1c0-5eed-4000-8000-00000000000a';
const SAPPHIC_NIGHT_TEMPLATE_ID = 'a7e3b1c0-5eed-4000-8000-00000000000b';

const exactCount = (
  templateId: string,
  roundPosition: number,
  questionPosition: number,
  value: number,
): SeededClosestRow => ({
  templateId,
  roundPosition,
  questionPosition,
  value,
  toleranceMode: 'exact',
  toleranceAmount: 0,
  unitEn: '',
  unitPt: '',
});

/**
 * The seeded template questions (frozen data of `1837900000000` and
 * `1840100000000`) whose tolerance or unit differs from the step 6 rule, as
 * the demo copy holds them: whole counts and ages are exact, other counts and
 * measurements keep "Within 10%", and five carry a unit. Years need no row
 * here, the year rule already gives them the demo's band. Frozen here so later
 * seed or demo edits never change what this migration writes.
 */
const SEEDED_CLOSEST_ROWS: readonly SeededClosestRow[] = [
  {
    // Pride and queer history: the stripes of the 1978 flag.
    templateId: 'a7e3b1c0-5eed-4000-8000-000000000001',
    roundPosition: 1,
    questionPosition: 4,
    value: 8,
    toleranceMode: 'exact',
    toleranceAmount: 0,
    unitEn: 'stripes',
    unitPt: 'riscas',
  },
  {
    // Eurovision: the points of Amar pelos dois.
    templateId: 'a7e3b1c0-5eed-4000-8000-000000000003',
    roundPosition: 1,
    questionPosition: 5,
    value: 758,
    toleranceMode: 'percent',
    toleranceAmount: 10,
    unitEn: 'points',
    unitPt: 'pontos',
  },
  {
    // Drag herstory: the queens of the first Drag Race season.
    templateId: 'a7e3b1c0-5eed-4000-8000-000000000004',
    roundPosition: 1,
    questionPosition: 4,
    value: 9,
    toleranceMode: 'exact',
    toleranceAmount: 0,
    unitEn: 'queens',
    unitPt: 'queens',
  },
  {
    // Lisbon queer icons: the copies of Sodoma Divinizada.
    templateId: 'a7e3b1c0-5eed-4000-8000-000000000005',
    roundPosition: 2,
    questionPosition: 4,
    value: 350,
    toleranceMode: 'percent',
    toleranceAmount: 10,
    unitEn: 'copies',
    unitPt: 'exemplares',
  },
  {
    // Lisbon queer icons: the height of the Principe Real cypress.
    templateId: 'a7e3b1c0-5eed-4000-8000-000000000005',
    roundPosition: 2,
    questionPosition: 5,
    value: 22,
    toleranceMode: 'percent',
    toleranceAmount: 10,
    unitEn: 'metres',
    unitPt: 'metros',
  },
  exactCount(POP_DIVAS_TEMPLATE_ID, 2, 0, 19),
  exactCount(POP_DIVAS_TEMPLATE_ID, 2, 1, 14),
  exactCount(POP_DIVAS_TEMPLATE_ID, 2, 3, 32),
  exactCount(POP_DIVAS_TEMPLATE_ID, 2, 4, 17),
  exactCount(QUEER_TV_NIGHT_TEMPLATE_ID, 4, 5, 80),
  exactCount(SCREEN_ICONS_TEMPLATE_ID, 5, 1, 17),
  exactCount(SCREEN_ICONS_TEMPLATE_ID, 5, 3, 8),
  exactCount(SCREEN_ICONS_TEMPLATE_ID, 5, 4, 3),
  exactCount(SAPPHIC_NIGHT_TEMPLATE_ID, 4, 4, 9),
];

/**
 * Pulse Live (code id `quizshow`) live v2: the enum labels `poll` (question
 * type), the sixteen second and third tier team keys and `both` (screen
 * language); the question columns for picture alt text, the reveal note, the
 * number unit and the slow picture reveal; the session flags, paired devices
 * and host answer key overrides; the player `left_at`; the team
 * `is_host_made`; the quiz open settings memory and template copy time; the
 * template content time and change notes. Stored MC answers move to
 * `correctIndexes`; a stored closest answer that names a whole year from
 * 1000 to 2100 gains a band of 10 years before 1990 and 5 years from 1990,
 * every other stored closest answer gains the "Within 10%" it always meant,
 * and the seeded template questions in `SEEDED_CLOSEST_ROWS` take the demo's
 * tolerance and unit. Round settings gain `isWarmUp` and `talkSeconds`.
 * Snapshots of open sessions are left as they are: the backend normalises
 * them on read. Covered by `src/database/quizshow-migrations.postgres.spec.ts`.
 *
 * NON-TRANSACTIONAL, like every other `ADD VALUE` migration here: a new label
 * must be COMMITTED before any statement may use it, so this opts out of the
 * wrapping transaction (`transaction = false`, honoured because
 * `data-source.ts` sets `migrationsTransactionMode: 'each'`). No statement
 * here uses a new label.
 *
 * Risk: without the transaction, a failure part way leaves the statements
 * before it applied. The enum labels come first and the guarded data updates
 * later. After fixing the cause, the data updates of steps 5 to 7 and 11 to
 * 12 are safe to run again (each `WHERE` skips rows already rewritten, or
 * the update writes the same values a second time); the
 * column additions of steps 4 and 8 to 10 need their half-applied columns
 * dropped first, and an enum label that already exists makes its `ADD VALUE`
 * fail. Run it against a copy of production first.
 */
export class QuizshowLiveV21840900000000 implements MigrationInterface {
  name = 'QuizshowLiveV21840900000000';

  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Step 1: the poll question type.
    await queryRunner.query(
      `ALTER TYPE "quizshow_question_type" ADD VALUE 'poll'`,
    );

    // Step 2: the 24 team keys, tiers 2 and 3 after the eight old names.
    for (const colorKey of NEW_TEAM_COLOR_KEYS) {
      await queryRunner.query(
        `ALTER TYPE "quizshow_team_color_key" ADD VALUE '${colorKey}'`,
      );
    }

    // Step 3: only `quizshow_quizzes.screen_language` uses this enum.
    await queryRunner.query(`ALTER TYPE "quizshow_language" ADD VALUE 'both'`);

    // Step 4: the new question fields.
    await queryRunner.query(
      `ALTER TABLE "quizshow_questions"
         ADD "media_alt_en" varchar(200) NOT NULL DEFAULT '',
         ADD "media_alt_pt" varchar(200) NOT NULL DEFAULT '',
         ADD "reveal_note_en" varchar(200) NOT NULL DEFAULT '',
         ADD "reveal_note_pt" varchar(200) NOT NULL DEFAULT '',
         ADD "number_unit_en" varchar(20) NOT NULL DEFAULT '',
         ADD "number_unit_pt" varchar(20) NOT NULL DEFAULT '',
         ADD "media_reveal" varchar(10) NOT NULL DEFAULT 'instant' CONSTRAINT "CHK_quizshow_questions_media_reveal" CHECK ("media_reveal" IN ('instant', 'slow'))`,
    );

    // Step 5: MC answers name every correct option.
    await queryRunner.query(
      `UPDATE "quizshow_questions" SET "answer" = jsonb_build_object('correctIndexes', jsonb_build_array(("answer" ->> 'correctIndex')::int)) WHERE "type" = 'multiple_choice' AND "answer" ? 'correctIndex'`,
    );

    // Step 6: closest answers gain a tolerance. A whole year first: a 10%
    // band on 1984 would accept about 198 years either way. The CASE keeps the
    // cast away from a value that is not a plain four digit number.
    await queryRunner.query(
      `UPDATE "quizshow_questions"
          SET "answer" = "answer" || jsonb_build_object('tolerance', jsonb_build_object('mode', 'absolute', 'amount', CASE WHEN ("answer" ->> 'value')::numeric < 1990 THEN 10 ELSE 5 END))
        WHERE "type" = 'closest_number' AND "answer" IS NOT NULL AND NOT ("answer" ? 'tolerance')
          AND CASE
                WHEN jsonb_typeof("answer" -> 'value') = 'number' AND ("answer" ->> 'value') ~ '^[0-9]{4}([.]0+)?$'
                THEN ("answer" ->> 'value')::numeric BETWEEN 1000 AND 2100
                ELSE false
              END`,
    );
    // Every other closest answer keeps the 10% band it was authored with.
    await queryRunner.query(
      `UPDATE "quizshow_questions" SET "answer" = "answer" || '{"tolerance":{"mode":"percent","amount":10}}'::jsonb WHERE "type" = 'closest_number' AND "answer" IS NOT NULL AND NOT ("answer" ? 'tolerance')`,
    );
    // The seeded template questions take the demo's tolerance and unit, while
    // they still hold the seeded value; a unit staff already set stays.
    await queryRunner.query(
      `UPDATE "quizshow_questions" AS "question"
          SET "answer" = "question"."answer" || jsonb_build_object('tolerance', jsonb_build_object('mode', "seed"."tolerance_mode", 'amount', "seed"."tolerance_amount")),
              "number_unit_en" = CASE WHEN "question"."number_unit_en" = '' AND "question"."number_unit_pt" = '' THEN "seed"."unit_en" ELSE "question"."number_unit_en" END,
              "number_unit_pt" = CASE WHEN "question"."number_unit_en" = '' AND "question"."number_unit_pt" = '' THEN "seed"."unit_pt" ELSE "question"."number_unit_pt" END
         FROM (SELECT unnest($1::uuid[]) AS "template_id",
                      unnest($2::int[]) AS "round_position",
                      unnest($3::int[]) AS "question_position",
                      unnest($4::numeric[]) AS "value",
                      unnest($5::text[]) AS "tolerance_mode",
                      unnest($6::numeric[]) AS "tolerance_amount",
                      unnest($7::text[]) AS "unit_en",
                      unnest($8::text[]) AS "unit_pt") AS "seed",
              "quizshow_quizzes" AS "quiz",
              "quizshow_rounds" AS "round"
        WHERE "quiz"."template_id" = "seed"."template_id"
          AND "round"."quiz_id" = "quiz"."id"
          AND "round"."position" = "seed"."round_position"
          AND "question"."round_id" = "round"."id"
          AND "question"."position" = "seed"."question_position"
          AND "question"."type" = 'closest_number'
          AND "question"."answer" -> 'value' = to_jsonb("seed"."value")`,
      [
        SEEDED_CLOSEST_ROWS.map((row) => row.templateId),
        SEEDED_CLOSEST_ROWS.map((row) => row.roundPosition),
        SEEDED_CLOSEST_ROWS.map((row) => row.questionPosition),
        SEEDED_CLOSEST_ROWS.map((row) => row.value),
        SEEDED_CLOSEST_ROWS.map((row) => row.toleranceMode),
        SEEDED_CLOSEST_ROWS.map((row) => row.toleranceAmount),
        SEEDED_CLOSEST_ROWS.map((row) => row.unitEn),
        SEEDED_CLOSEST_ROWS.map((row) => row.unitPt),
      ],
    );

    // Step 7: every round gets the warm-up flag and the talk beat, both off.
    await queryRunner.query(
      `UPDATE "quizshow_rounds" SET "settings" = "settings" || '{"isWarmUp":false,"talkSeconds":0}'::jsonb WHERE NOT ("settings" ? 'isWarmUp')`,
    );

    // Step 8: the session flags, the paired devices and the host corrections.
    await queryRunner.query(
      `ALTER TABLE "quizshow_sessions"
         ADD "is_practice" boolean NOT NULL DEFAULT false,
         ADD "is_join_locked" boolean NOT NULL DEFAULT false,
         ADD "is_auto_advance_on" boolean NOT NULL DEFAULT false,
         ADD "paired_devices" jsonb NOT NULL DEFAULT '[]',
         ADD "answer_key_overrides" jsonb NOT NULL DEFAULT '{}'`,
    );

    // Step 9: a player who left the lobby keeps the row.
    await queryRunner.query(
      `ALTER TABLE "quizshow_players" ADD "left_at" timestamptz(3) NULL`,
    );

    // Step 10: teams the host made before anyone joined.
    await queryRunner.query(
      `ALTER TABLE "quizshow_teams" ADD "is_host_made" boolean NOT NULL DEFAULT false`,
    );

    // Step 11: the open settings memory and the template copy time. An
    // existing copy takes the later of the day the quiz was created and the
    // day its template was published (contract 13, amends 8.1), so a quiz
    // that imported the template after a later publish never shows a false
    // update.
    await queryRunner.query(
      `ALTER TABLE "quizshow_quizzes"
         ADD "last_open_settings" jsonb NULL,
         ADD "source_template_copied_at" timestamptz(3) NULL`,
    );
    await queryRunner.query(
      `UPDATE "quizshow_quizzes" AS "quiz"
          SET "source_template_copied_at" = GREATEST("quiz"."created_at", "template"."published_at")
         FROM "quizshow_templates" AS "template"
        WHERE "template"."id" = "quiz"."source_template_id"`,
    );

    // Step 12: the template content time, which published templates take from
    // their publish time, and the change notes.
    await queryRunner.query(
      `ALTER TABLE "quizshow_templates"
         ADD "content_updated_at" timestamptz(3) NULL,
         ADD "change_note_en" varchar(300) NOT NULL DEFAULT '',
         ADD "change_note_pt" varchar(300) NOT NULL DEFAULT ''`,
    );
    await queryRunner.query(
      `UPDATE "quizshow_templates" SET "content_updated_at" = "published_at" WHERE "published_at" IS NOT NULL`,
    );
  }

  public async down(): Promise<void> {
    // Not reversible: Postgres cannot drop an enum value. Fails loudly so the
    // ledger row stays.
    throw new Error(
      'Irreversible: QuizshowLiveV21840900000000 adds enum values and Postgres cannot drop an enum value. Restore from a backup instead.',
    );
  }
}
