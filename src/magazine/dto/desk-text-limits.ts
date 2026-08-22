/**
 * Length caps for the magazine desk's staff-facing write DTOs (CNT-14).
 *
 * These fields were `@IsString() @MinLength(1)` / `@IsNotEmpty()` with no
 * ceiling, unlike the member-facing `CreateReaderCommentDto` (10 000) and
 * `CreateStorySubmissionDto` (5 000). Staff-only is a reason the risk is low,
 * not a reason to store an unbounded blob: one pasted manuscript in a letter or
 * a note becomes a multi-MB row that every `getPieceRecordFull` / `listLetters`
 * call ships back, and piece messages are additionally fanned out as
 * notifications.
 *
 * Three tiers, sized off the columns they land in and the reader-facing
 * precedents rather than invented per DTO:
 */

/** One-line identifiers: section, kind, byline, `who`, `pages`. */
export const DESK_SHORT_TEXT_MAX = 200;

/**
 * A piece headline. Deliberately looser than `DESK_SHORT_TEXT_MAX`: the same
 * `magazine_piece.title` column is also written from the article editor, where
 * `UpdateArticleDto.title` allows 2 000 characters of contentEditable markup
 * that `toPlainText` strips down before it is mirrored onto the piece. Capping
 * the commission form tighter than that mirror can produce would make the two
 * write paths disagree about what a legal title is.
 */
export const DESK_TITLE_MAX = 500;

/** A sentence or two of display copy: the issue Cover & Contents blurb. */
export const DESK_BLURB_MAX = 500;

/**
 * Prose bodies: letters, corrections, editor↔writer messages, article notes.
 * Matches `CreateReaderCommentDto`'s cap so the desk and the reader side agree
 * on what "a long comment" means.
 */
export const DESK_BODY_MAX = 10000;

/** A block id anchor on an article note — a slug/uuid, never prose. */
export const DESK_BLOCK_ID_MAX = 100;
