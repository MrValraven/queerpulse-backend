import { displayNameOf } from '../events/event-community-response';
import { usedLanguages } from './quizshow-quiz-validation';
import {
  QUIZSHOW_LIMITS,
  QUIZSHOW_TEMPLATE_CARD_FIELDS,
  type QuizshowLanguageMode,
  type QuizshowQuiz,
  type QuizshowTemplateCard,
  type QuizshowTemplateCardField,
  type QuizshowTemplateCardText,
  type QuizshowTemplateDetail,
  type QuizshowTemplatePreview,
  type QuizshowTemplateRow,
  type QuizshowTemplateStatus,
  type QuizshowText,
} from './quizshow.contract';

/**
 * Raw reads and pure helpers for the staff quiz templates. They name tables
 * only, so they stay free of Nest and of entity metadata.
 */

/** The round count, question count and adults flag of the joined "quiz". */
const TEMPLATE_QUIZ_COUNTS = `
    (
      SELECT COUNT(*)::int FROM "quizshow_rounds" "round"
      WHERE "round"."quiz_id" = "quiz"."id"
        AND "round"."kind"::text <> 'wheel'
    ) AS "round_count",
    (
      SELECT COUNT(*)::int
      FROM "quizshow_questions" "question"
      INNER JOIN "quizshow_rounds" "round" ON "round"."id" = "question"."round_id"
      WHERE "round"."quiz_id" = "quiz"."id"
    ) AS "question_count",
    EXISTS (
      SELECT 1 FROM "quizshow_rounds" "round"
      WHERE "round"."quiz_id" = "quiz"."id"
        AND "round"."content_label" = 'adults'
    ) AS "has_adults_rounds"`;

/** Staff list: every template with its quiz counts and last editor, drafts first, then published, each by last edit. */
export const TEMPLATE_ROWS_SQL = `
  SELECT
    "template"."id" AS "id",
    "template"."card_title_en" AS "card_title_en",
    "template"."card_title_pt" AS "card_title_pt",
    "template"."published_at" AS "published_at",
    "quiz"."updated_at" AS "updated_at",
    "editor"."first_name" AS "editor_first_name",
    "editor"."last_name" AS "editor_last_name",${TEMPLATE_QUIZ_COUNTS}
  FROM "quizshow_templates" "template"
  INNER JOIN "quizshow_quizzes" "quiz" ON "quiz"."template_id" = "template"."id"
  LEFT JOIN "profiles" "editor" ON "editor"."user_id" = "quiz"."updated_by_user_id"
  ORDER BY ("template"."published_at" IS NOT NULL) ASC, "quiz"."updated_at" DESC, "template"."id" ASC
`;

/** Host picker: the card of every published template, oldest publish first. */
export const TEMPLATE_CARDS_SQL = `
  SELECT
    "template"."id" AS "id",
    "template"."card_title_en" AS "card_title_en",
    "template"."card_title_pt" AS "card_title_pt",
    "template"."card_description_en" AS "card_description_en",
    "template"."card_description_pt" AS "card_description_pt",
    "template"."content_updated_at" AS "content_updated_at",
    "template"."published_at" AS "published_at",
    "quiz"."languages" AS "languages",${TEMPLATE_QUIZ_COUNTS}
  FROM "quizshow_templates" "template"
  INNER JOIN "quizshow_quizzes" "quiz" ON "quiz"."template_id" = "template"."id"
  WHERE "template"."published_at" IS NOT NULL
  ORDER BY "template"."published_at" ASC, "template"."id" ASC
`;

/** $1 template id: the template columns, its quiz id and the publisher's names. */
export const TEMPLATE_DETAIL_SQL = `
  SELECT
    "template"."id" AS "id",
    "template"."card_title_en" AS "card_title_en",
    "template"."card_title_pt" AS "card_title_pt",
    "template"."card_description_en" AS "card_description_en",
    "template"."card_description_pt" AS "card_description_pt",
    "template"."staff_notes" AS "staff_notes",
    "template"."published_at" AS "published_at",
    "template"."content_updated_at" AS "content_updated_at",
    "template"."change_note_en" AS "change_note_en",
    "template"."change_note_pt" AS "change_note_pt",
    "quiz"."id" AS "quiz_id",
    "publisher"."first_name" AS "first_name",
    "publisher"."last_name" AS "last_name"
  FROM "quizshow_templates" "template"
  INNER JOIN "quizshow_quizzes" "quiz" ON "quiz"."template_id" = "template"."id"
  LEFT JOIN "profiles" "publisher" ON "publisher"."user_id" = "template"."published_by_user_id"
  WHERE "template"."id" = $1
`;

/**
 * $1 template id: the card text and quiz id of a published template. A draft
 * reads as no row, so the host preview never shows one.
 */
export const TEMPLATE_PREVIEW_SQL = `
  SELECT
    "template"."id" AS "id",
    "template"."card_title_en" AS "card_title_en",
    "template"."card_title_pt" AS "card_title_pt",
    "template"."card_description_en" AS "card_description_en",
    "template"."card_description_pt" AS "card_description_pt",
    "quiz"."id" AS "quiz_id"
  FROM "quizshow_templates" "template"
  INNER JOIN "quizshow_quizzes" "quiz" ON "quiz"."template_id" = "template"."id"
  WHERE "template"."id" = $1
    AND "template"."published_at" IS NOT NULL
`;

export interface TemplateListRow {
  id: string;
  card_title_en: string;
  card_title_pt: string;
  published_at: Date | string | null;
  updated_at: Date | string;
  editor_first_name: string | null;
  editor_last_name: string | null;
  round_count: number;
  question_count: number;
  has_adults_rounds: boolean;
}

export interface TemplateCardRow {
  id: string;
  card_title_en: string;
  card_title_pt: string;
  card_description_en: string;
  card_description_pt: string;
  content_updated_at: Date | string | null;
  published_at: Date | string;
  languages: QuizshowLanguageMode;
  round_count: number;
  question_count: number;
  has_adults_rounds: boolean;
}

export interface TemplateDetailRow {
  id: string;
  card_title_en: string;
  card_title_pt: string;
  card_description_en: string;
  card_description_pt: string;
  staff_notes: string | null;
  published_at: Date | string | null;
  content_updated_at: Date | string | null;
  change_note_en: string | null;
  change_note_pt: string | null;
  quiz_id: string;
  first_name: string | null;
  last_name: string | null;
}

export interface TemplatePreviewRow {
  id: string;
  card_title_en: string;
  card_title_pt: string;
  card_description_en: string;
  card_description_pt: string;
  quiz_id: string;
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function toNullableIsoString(value: Date | string | null): string | null {
  return value === null ? null : toIsoString(value);
}

function statusOf(publishedAt: Date | string | null): QuizshowTemplateStatus {
  return publishedAt === null ? 'draft' : 'published';
}

/**
 * The latest publish of a published template: the content stamp, else the
 * publish date for a row the migration backfill has not reached.
 */
function lastPublishedAtOf(
  contentUpdatedAt: Date | string | null,
  publishedAt: Date | string,
): string {
  return toIsoString(contentUpdatedAt ?? publishedAt);
}

/** The display name of a joined profile; null when the account is gone. */
export function nameOf(
  firstName: string | null,
  lastName: string | null,
): string | null {
  return displayNameOf({
    firstName: firstName ?? '',
    lastName: lastName ?? '',
  });
}

export function toTemplateRow(row: TemplateListRow): QuizshowTemplateRow {
  return {
    id: row.id,
    title: { en: row.card_title_en, pt: row.card_title_pt },
    status: statusOf(row.published_at),
    roundCount: Number(row.round_count),
    questionCount: Number(row.question_count),
    hasAdultsRounds: row.has_adults_rounds === true,
    updatedAt: toIsoString(row.updated_at),
    updatedByName: nameOf(row.editor_first_name, row.editor_last_name),
    publishedAt: toNullableIsoString(row.published_at),
  };
}

/** The host card: the card text, languages and counts, and nothing else. */
export function toTemplateCard(row: TemplateCardRow): QuizshowTemplateCard {
  return {
    id: row.id,
    title: { en: row.card_title_en, pt: row.card_title_pt },
    description: { en: row.card_description_en, pt: row.card_description_pt },
    languages: row.languages,
    roundCount: Number(row.round_count),
    questionCount: Number(row.question_count),
    hasAdultsRounds: row.has_adults_rounds === true,
    lastPublishedAt: lastPublishedAtOf(
      row.content_updated_at,
      row.published_at,
    ),
  };
}

/** The staff detail from its row and the assembled quiz. */
export function toTemplateDetail(
  row: TemplateDetailRow,
  quiz: QuizshowQuiz,
): QuizshowTemplateDetail {
  return {
    id: row.id,
    card: {
      title: { en: row.card_title_en, pt: row.card_title_pt },
      description: {
        en: row.card_description_en,
        pt: row.card_description_pt,
      },
    },
    staffNotes: row.staff_notes ?? '',
    status: statusOf(row.published_at),
    publishedAt: toNullableIsoString(row.published_at),
    publishedByName: nameOf(row.first_name, row.last_name),
    quiz,
    changeNote: { en: row.change_note_en ?? '', pt: row.change_note_pt ?? '' },
    lastPublishedAt:
      row.published_at === null
        ? null
        : lastPublishedAtOf(row.content_updated_at, row.published_at),
  };
}

/**
 * A wheel row's stored slice count for the preview's round checklist (item
 * 23): null for Auto and for a stored value that is not a number, rounded
 * as the import-source SQL's `::numeric::int` cast; null on every other row.
 */
function previewSliceCountOf(
  round: QuizshowQuiz['rounds'][number],
): number | null {
  if (round.kind !== 'wheel') return null;
  const storedSliceCount: unknown = (round.settings as { sliceCount?: unknown })
    .sliceCount;
  return typeof storedSliceCount === 'number' &&
    Number.isFinite(storedSliceCount)
    ? Math.round(storedSliceCount)
    : null;
}

/**
 * The host preview of a published template: the card text, the languages and
 * each row's title, label and prompt texts. Every field is copied by name, so
 * options, answers, notes and media never reach the payload.
 */
export function toTemplatePreview(
  row: TemplatePreviewRow,
  quiz: QuizshowQuiz,
): QuizshowTemplatePreview {
  return {
    templateId: row.id,
    title: { en: row.card_title_en, pt: row.card_title_pt },
    description: { en: row.card_description_en, pt: row.card_description_pt },
    languages: quiz.languages,
    rounds: quiz.rounds.map((round, roundIndex) => ({
      roundIndex,
      kind: round.kind,
      title: { en: round.title.en, pt: round.title.pt },
      questionCount: round.questions.length,
      sliceCount: previewSliceCountOf(round),
      contentLabel: round.contentLabel,
      prompts:
        round.kind === 'wheel'
          ? []
          : round.questions.map((question) => ({
              en: question.prompt.en,
              pt: question.prompt.pt,
            })),
    })),
  };
}

/**
 * The card fields that are blank after trim, in `QUIZSHOW_TEMPLATE_CARD_FIELDS`
 * order, for the languages the quiz uses.
 */
export function missingCardFields(
  card: QuizshowTemplateCardText,
  languages: QuizshowLanguageMode,
): QuizshowTemplateCardField[] {
  const languagesInUse: readonly string[] = usedLanguages(languages);
  return QUIZSHOW_TEMPLATE_CARD_FIELDS.filter((field) => {
    const [part, language] = field.split('.') as [
      'title' | 'description',
      'en' | 'pt',
    ];
    return (
      languagesInUse.includes(language) && card[part][language].trim() === ''
    );
  });
}

const COPY_SUFFIXES: QuizshowText = { en: ' (copy)', pt: ' (cópia)' };

/** One title with its suffix; the base is cut by characters so the result fits the card title limit. */
function suffixedTitle(title: string, suffix: string): string {
  if (title.trim() === '') return '';
  const room = QUIZSHOW_LIMITS.templateCardTitleMax - suffix.length;
  const base = Array.from(title).slice(0, room).join('').trimEnd();
  return `${base}${suffix}`;
}

/** The card title of a duplicate: ' (copy)' and ' (cópia)', within 120 characters; a blank title stays ''. */
export function withCopySuffix(title: QuizshowText): QuizshowText {
  return {
    en: suffixedTitle(title.en, COPY_SUFFIXES.en),
    pt: suffixedTitle(title.pt, COPY_SUFFIXES.pt),
  };
}

/** How the audit row names a template: the EN card title, else the PT one, else the id. */
export function templateAuditName(
  card: QuizshowTemplateCardText,
  templateId: string,
): string {
  return card.title.en.trim() || card.title.pt.trim() || templateId;
}
