import { Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayNotEmpty, IsArray, Matches } from 'class-validator';

/** The entity kinds a mention can name. Mirrors the frontend's `MentionSegment`
 *  kinds minus `topic`: a `#tag` mention always renders as its own tag, so a
 *  topic is never resolved to a name and is never sent here. */
export const MENTION_NAME_KINDS = [
  'member',
  'community',
  'business',
  'event',
  'thread',
] as const;

export type MentionNameKind = (typeof MENTION_NAME_KINDS)[number];

/** How many mentions one resolve call may name. A bio is a few sentences, so
 *  this is far more than any real one carries, and small enough that the five
 *  `IN (...)` reads behind it stay trivial. */
export const MAX_MENTION_NAME_REFS = 50;

/** `kind:slug`, with the same slug alphabet the mention tokenizer accepts on
 *  both sides (`extractMentions` here, `parseMentions` in the frontend). */
const MENTION_REF = new RegExp(
  `^(?:${MENTION_NAME_KINDS.join('|')}):[a-z0-9][a-z0-9-]*$`,
);

/** `?refs=member:ana-lopes,c…` arrives as one string; anything else is left for
 *  the validators below to reject rather than coerced into a shape it never
 *  had (mirrors `AssessJoinRequestsQuery.splitIdList`). */
function splitRefList(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * `GET /mentions/names?refs=member:ana-lopes,community:lisboa-queer`.
 *
 * Addressed by `kind:slug` only — the caller says exactly which mentions it is
 * about to render, and gets back only those. There is no listing form and no
 * wildcard, so this can name the handful of targets one bio points at without
 * becoming a way to walk the member directory.
 */
export class ResolveMentionNamesQuery {
  @Transform(({ value }) => splitRefList(value))
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(MAX_MENTION_NAME_REFS)
  @Matches(MENTION_REF, {
    each: true,
    message: 'each ref must be "kind:slug" for a known mention kind',
  })
  refs!: string[];
}
