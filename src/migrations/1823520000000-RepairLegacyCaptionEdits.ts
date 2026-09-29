// DO NOT RUN: authored for review only; the maintainer runs migrations.
// Applied at backend boot while pending: `ensureDatabaseSchema` (called from
// `src/main.ts`) runs every pending migration at startup unless
// `AUTO_RUN_MIGRATIONS=false` is set. To apply it by hand instead, set that
// flag, check `pnpm run typeorm migration:show`, then `pnpm run migration:run`.
// This one rewrites stored message data, so count the rows it will change
// before a boot applies it: run `CANDIDATE_ROWS_SQL` below with its SELECT
// list (the language sample subquery included) swapped for `count(*)`, its
// three `${...}` lists expanded, and its final `ORDER BY "m"."id"` and
// `FOR UPDATE OF "m"` clauses dropped.
import { MigrationInterface, QueryRunner } from 'typeorm';

// Only the migration class is exported. TypeORM loads every exported
// function in `src/migrations` as a migration, so an exported helper would
// fail the boot.

/** Frozen copy of `CAPTION_EDIT_MESSAGE_KINDS`. */
const CAPTIONED_KINDS = ['image', 'document', 'gif'] as const;

/** Frozen copy of `MAX_ATTACHMENT_CAPTION_LENGTH`. */
const MAX_REPAIRED_CAPTION_LENGTH = 1000;

/** Rows per `UPDATE`, keeping each statement's parameter arrays small. */
const UPDATE_BATCH_SIZE = 500;

type CaptionedKind = (typeof CAPTIONED_KINDS)[number];
type FallbackLanguage = 'en' | 'pt';

/** The label each kind's send path stores as `body`, per interface language. */
const FALLBACK_LABEL_BY_KIND: Record<
  CaptionedKind,
  Record<FallbackLanguage, string>
> = {
  image: { en: 'Photo', pt: 'Foto' },
  document: { en: 'File', pt: 'Ficheiro' },
  gif: { en: 'GIF', pt: 'GIF' },
};

/**
 * Every body a send path has stored for a captioned kind: each translated
 * label, the "Document" word of the backend comments and push copy, and the
 * two raw catalog keys the translator returned while a key was missing or
 * its namespace had not loaded.
 */
const KNOWN_FALLBACK_LABELS: readonly string[] = [
  ...new Set([
    ...Object.values(FALLBACK_LABEL_BY_KIND).flatMap((labels) =>
      Object.values(labels),
    ),
    'Document',
    'messages:attachments.fallbackText',
    'messages:attachments.documentFallbackText',
  ]),
];

/** The photo and document labels, the only ones that reveal a language. */
const LANGUAGE_SAMPLE_LABELS: readonly string[] = [
  FALLBACK_LABEL_BY_KIND.image.en,
  FALLBACK_LABEL_BY_KIND.image.pt,
  FALLBACK_LABEL_BY_KIND.document.en,
  FALLBACK_LABEL_BY_KIND.document.pt,
];

const PORTUGUESE_SAMPLE_LABELS: readonly string[] = [
  FALLBACK_LABEL_BY_KIND.image.pt,
  FALLBACK_LABEL_BY_KIND.document.pt,
];

const quotedList = (values: readonly string[]): string =>
  values.map((value) => `'${value}'`).join(', ');

/**
 * The rows to repair, locked for the rest of the migration's transaction.
 * `senderFallbackSample` is the body of the sender's newest unedited photo or
 * document that they sent themselves (a forward keeps the original author's
 * label) and that still holds a fallback label, used to pick the language of
 * the restored label.
 */
const CANDIDATE_ROWS_SQL = `
  SELECT
    "m"."id",
    "m"."kind",
    "m"."body",
    "m"."attachment",
    (
      SELECT "sample"."body" FROM "messages" "sample"
      WHERE "sample"."sender_id" = "m"."sender_id"
        AND "sample"."kind" IN ('image', 'document')
        AND "sample"."edited_at" IS NULL
        AND "sample"."deleted_at" IS NULL
        AND "sample"."forwarded" = false
        AND "sample"."body" IN (${quotedList(LANGUAGE_SAMPLE_LABELS)})
      ORDER BY "sample"."created_at" DESC
      LIMIT 1
    ) AS "senderFallbackSample"
  FROM "messages" "m"
  WHERE "m"."kind" IN (${quotedList(CAPTIONED_KINDS)})
    AND "m"."edited_at" IS NOT NULL
    AND "m"."deleted_at" IS NULL
    AND "m"."erased_sender_ref" IS NULL
    AND "m"."body" NOT IN (${quotedList(KNOWN_FALLBACK_LABELS)})
    AND "m"."attachment" IS NOT NULL
    AND jsonb_typeof("m"."attachment") = 'object'
    AND NOT ("m"."attachment" ? 'stickerId')
    AND NOT EXISTS (
      SELECT 1 FROM "content_moderation" "cm"
      WHERE "cm"."subject_type" = 'message'
        AND "cm"."subject_id" = "m"."id"::text
        AND ("cm"."hidden_at" IS NOT NULL OR "cm"."removed_at" IS NOT NULL)
    )
  ORDER BY "m"."id"
  FOR UPDATE OF "m"
`;

/**
 * Writes one batch. The three arrays line up by index; each attachment
 * arrives as JSON text and is cast back to `jsonb`.
 */
const REPAIR_BATCH_SQL = `
  WITH "repaired" AS (
    UPDATE "messages" "m"
    SET "body" = "fix"."body",
        "attachment" = "fix"."attachment"::jsonb
    FROM unnest($1::uuid[], $2::text[], $3::text[])
      AS "fix"("id", "body", "attachment")
    WHERE "m"."id" = "fix"."id"
    RETURNING 1
  )
  SELECT count(*)::int AS "repairedCount" FROM "repaired"
`;

interface CandidateRow {
  id: string;
  kind: CaptionedKind;
  body: string;
  attachment: Record<string, unknown>;
  senderFallbackSample: string | null;
}

// Inline copy of `countCharacters`, `removeLoneSurrogates` and
// `truncateCharacters` from `src/common/text-characters.ts` (2026-09-29),
// kept here so a later change to that helper cannot change what this
// migration did. Characters are counted the way class-validator's
// `@MaxLength` counts them: one per code point, with the text and emoji
// presentation selectors (U+FE0E, U+FE0F) counting zero. A cut therefore
// never splits a surrogate pair, whose lone half `jsonb` refuses.

const PRESENTATION_SELECTORS: ReadonlySet<string> = new Set([
  '\uFE0E',
  '\uFE0F',
]);

/** A high surrogate with no low surrogate after it, or a low one with no high one before it. */
const LONE_SURROGATE_PATTERN =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

function removeLoneSurrogates(text: string): string {
  return text.replace(LONE_SURROGATE_PATTERN, '');
}

function countCharacters(text: string): number {
  let characterCount = 0;
  for (const codePoint of text) {
    if (!PRESENTATION_SELECTORS.has(codePoint)) {
      characterCount += 1;
    }
  }
  return characterCount;
}

/**
 * The leading `maxCharacters` characters of `text`, counted like
 * `countCharacters`. A presentation selector right after the last kept
 * character stays with it.
 */
function truncateCharacters(text: string, maxCharacters: number): string {
  const wellFormed = removeLoneSurrogates(text);
  if (wellFormed.length <= maxCharacters) {
    return wellFormed;
  }
  let characterCount = 0;
  let endIndex = 0;
  for (const codePoint of wellFormed) {
    if (!PRESENTATION_SELECTORS.has(codePoint)) {
      if (characterCount === maxCharacters) {
        break;
      }
      characterCount += 1;
    }
    endIndex += codePoint.length;
  }
  return wellFormed.slice(0, endIndex);
}

interface RepairedCaption {
  caption: string | undefined;
  wasCut: boolean;
}

/**
 * The caption-specific steps of `sanitizeAttachmentCaption`, minus its HTML
 * pass (see the class comment), applied to a body that was already stored
 * through `sanitizeMessageBody`.
 */
function repairedCaption(editedBody: string): RepairedCaption {
  const withNormalizedLineBreaks = editedBody
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
  const withoutControlCharacters = withNormalizedLineBreaks.replace(
    // eslint-disable-next-line no-control-regex -- deliberately matching every C0/DEL control byte except \n (\x0a), the same set the caption pass strips.
    /[\x00-\x09\x0b-\x1f\x7f]/g,
    '',
  );
  const trimmed = removeLoneSurrogates(withoutControlCharacters.trim());
  const wasCut = countCharacters(trimmed) > MAX_REPAIRED_CAPTION_LENGTH;
  const bounded = truncateCharacters(trimmed, MAX_REPAIRED_CAPTION_LENGTH);
  return {
    caption: bounded.length > 0 ? bounded : undefined,
    wasCut,
  };
}

/** The fallback label a repaired row's body goes back to. */
function restoredFallbackLabel(
  kind: CaptionedKind,
  senderFallbackSample: string | null,
): string {
  const language: FallbackLanguage =
    senderFallbackSample !== null &&
    PORTUGUESE_SAMPLE_LABELS.includes(senderFallbackSample)
      ? 'pt'
      : 'en';
  return FALLBACK_LABEL_BY_KIND[kind][language];
}

/**
 * Whether writing `caption` changes a caption readers could see: the row held
 * a caption with visible text (the bubble shows one only when it trims to
 * something) and the repaired value differs from it.
 */
function replacesVisibleCaption(
  attachment: Record<string, unknown>,
  caption: string | undefined,
): boolean {
  const previousCaption = attachment.caption;
  return (
    typeof previousCaption === 'string' &&
    previousCaption.trim().length > 0 &&
    previousCaption !== caption
  );
}

/** The attachment with its caption replaced by `caption`, or removed. */
function attachmentWithCaption(
  attachment: Record<string, unknown>,
  caption: string | undefined,
): Record<string, unknown> {
  const withoutCaption = { ...attachment };
  delete withoutCaption.caption;
  return caption === undefined
    ? withoutCaption
    : { ...withoutCaption, caption };
}

/**
 * ENG-405 cleanup. Until the fix in `MessagesService.editMessage`, editing a
 * photo, document or GIF rewrote the message `body`, which holds only the
 * send-time fallback label ("Photo", "File", "GIF"), while the bubble kept
 * rendering `attachment.caption`. The author saw no change in the thread,
 * and the edited words surfaced in the inbox preview in place of the label.
 * The fixed edit writes the caption and leaves `body` alone; this migration
 * puts the rows edited before the fix into that same shape: the edited text
 * moves into `attachment.caption` and `body` gets its fallback label back.
 *
 * A row is repaired when all of these hold:
 * - `kind` is `image`, `document` or `gif` (`CAPTION_EDIT_MESSAGE_KINDS` in
 *   `src/messaging/messaging.constants.ts`, frozen here as
 *   `CAPTIONED_KINDS`);
 * - `edited_at` is set, so an unedited message is never touched;
 * - `body` matches none of the fallback labels any client or server path has
 *   written (`KNOWN_FALLBACK_LABELS`), compared across all three kinds, so a
 *   body that equals any label counts as untouched;
 * - it carries an object attachment with no `stickerId` (a forged sticker
 *   shape has no caption to hold the text);
 * - it is live: soft-deleted rows (`deleted_at` set, including every
 *   evidence-held tombstone) are left alone;
 * - it is no held evidence row: a message of an erased sender kept readable
 *   while a report is open (`erased_sender_ref` set) is left as it is;
 * - no moderator takedown names it: the `content_moderation` row check is
 *   the same one `notModeratedMessagePredicate` applies, so a hidden or
 *   removed message keeps exactly what the moderator acted on.
 *
 * Where the fallback labels come from. The frontend sends the label in the
 * sender's interface language: `messages:attachments.fallbackText`
 * ("Photo" in EN, "Foto" in PT) for an image,
 * `messages:attachments.documentFallbackText` ("File" in EN, "Ficheiro" in
 * PT) for a document, and a fixed "GIF" for a GIF
 * (`useAttachmentMessageSendActions.ts`, `useMessageSendActions.ts`).
 * The translated values have not changed since the keys were added, but the
 * translator returns the raw key when a key is missing: the document key
 * shipped without catalog entries from 2026-09-06 to 2026-09-11, and either
 * key can miss while the `messages` namespace is still loading. Both raw keys
 * are therefore listed too. "Document" is the word the backend comments and
 * the push copy use for a document, and it is listed as well so a row
 * holding it counts as untouched. A forward resends the stored body with no
 * `edited_at`, so it is out of scope here even when it copied a pre-fix
 * edit's text.
 *
 * Which label goes back. No stored column records a member's language, so
 * the repaired body follows the sender's own newest unedited photo or
 * document that was not a forward (a forward keeps the original author's
 * label): a Portuguese label there ("Foto", "Ficheiro") restores the
 * Portuguese label, and anything else (no such message, an erased sender)
 * restores the English one. A GIF always gets "GIF".
 *
 * How the caption is cleaned. The edited body already went through
 * `sanitizeMessageBody` when it was saved, so only the caption-specific
 * steps of `MessagingCoreService.sanitizeAttachmentCaption` are applied:
 * line breaks normalised to `\n`, every C0/DEL control byte except `\n`
 * removed (a tab included, as the caption pass does), outer whitespace
 * trimmed, and the result cut at `MAX_ATTACHMENT_CAPTION_LENGTH` (1000)
 * characters counted the way `@MaxLength` counts them (code points, the
 * presentation selectors free), through an inline copy of
 * `truncateCharacters`. The cut never splits a surrogate pair, so no row
 * can carry the lone half Postgres refuses in `jsonb`. The HTML pass (`toStoredPlainText`) is deliberately
 * skipped: it deletes ordinary chat text such as `x<y and y>z` (see
 * `sanitizeMessageBody`'s own doc), and every surface renders the caption as
 * text. Text that cleans down to nothing leaves the attachment without a
 * caption, as an empty edit does today.
 *
 * An existing caption is replaced: the edited body is the author's newest
 * text for that bubble, the product owner's decision of 2026-09-29. Before
 * the fix the edit field opened on the body label, so readers kept seeing
 * the old caption; `up` counts every visible caption it replaces so the
 * deploy log records how many bubbles now show different text. This holds
 * when the migration ships in the same deploy as the ENG-405 fix: it runs
 * at boot before the fixed service serves an edit, so no caption on a row
 * this repair touches came from a post-fix edit.
 *
 * `edited_at` is kept, so the bubble still shows its edited marker. Search,
 * starred search and mention scans compute their text from the caption at
 * query time (there is no stored search column on `messages`), so the
 * repaired rows become searchable by the edited text with no further update.
 *
 * `up` logs how many rows it repaired, how many visible captions it
 * replaced and how many captions it cut, so the deploy log records the
 * change.
 *
 * `down` is a no-op: the pre-repair shape was the bug, and it is not
 * restored.
 */
export class RepairLegacyCaptionEdits1823520000000 implements MigrationInterface {
  name = 'RepairLegacyCaptionEdits1823520000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const candidates = (await queryRunner.query(
      CANDIDATE_ROWS_SQL,
    )) as CandidateRow[];
    let repairedCount = 0;
    let replacedCaptionCount = 0;
    let cutCaptionCount = 0;
    for (
      let batchStart = 0;
      batchStart < candidates.length;
      batchStart += UPDATE_BATCH_SIZE
    ) {
      const batch = candidates.slice(
        batchStart,
        batchStart + UPDATE_BATCH_SIZE,
      );
      const ids: string[] = [];
      const bodies: string[] = [];
      const attachments: string[] = [];
      for (const row of batch) {
        const { caption, wasCut } = repairedCaption(row.body);
        if (wasCut) cutCaptionCount += 1;
        if (replacesVisibleCaption(row.attachment, caption)) {
          replacedCaptionCount += 1;
        }
        ids.push(row.id);
        bodies.push(restoredFallbackLabel(row.kind, row.senderFallbackSample));
        attachments.push(
          JSON.stringify(attachmentWithCaption(row.attachment, caption)),
        );
      }
      const result = (await queryRunner.query(REPAIR_BATCH_SQL, [
        ids,
        bodies,
        attachments,
      ])) as { repairedCount: number }[];
      repairedCount += result[0]?.repairedCount ?? 0;
    }
    // Deliberately loud: the one record of how many rows were rewritten.
    console.log(
      `[RepairLegacyCaptionEdits] repaired ${repairedCount} message(s), replaced ${replacedCaptionCount} visible caption(s), cut ${cutCaptionCount} caption(s) to ${MAX_REPAIRED_CAPTION_LENGTH} characters`,
    );
  }

  public async down(): Promise<void> {
    // Irreversible by design: see the class comment.
  }
}
