import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  MaxLength,
} from 'class-validator';
import { MAX_PAGE } from '../../common/pagination';
import {
  LISTING_ACCESSIBILITY_QUESTION_SLUGS,
  ListingAccessibilityQuestionSlug,
} from '../listing-accessibility';
import {
  LISTING_OWNED_BY_VALUES,
  ListingOwnedBy,
  isListingOwnedBy,
  normalizeListingOwnedBy,
} from '../listing-owned-by';

/**
 * Normalizes whatever Express handed us for a multi-value filter (`access`,
 * and `owned` through `toOwnedByList`) into a de-duplicated string array, so
 * one repeated parameter and one comma-joined parameter mean the same thing:
 *
 *   ?access=step-free-entrance&access=accessible-toilet
 *   ?access=step-free-entrance,accessible-toilet
 *
 * Non-string entries are passed straight through rather than coerced, so an
 * odd value fails `@IsIn` with a 400 instead of being silently dropped: a
 * misspelt access requirement must never quietly widen the result set for
 * someone who is filtering on one.
 */
function toQueryValueList(value: unknown): unknown {
  if (value === undefined || value === null) return undefined;
  const received: unknown[] = Array.isArray(value)
    ? (value as unknown[])
    : [value];
  const cleaned = received.flatMap((entry) =>
    typeof entry === 'string'
      ? entry.split(',').map((part) => part.trim())
      : [entry],
  );
  return [...new Set(cleaned.filter((entry) => entry !== ''))];
}

/**
 * `owned`, parsed exactly like `access` (repeated or comma-joined, each value
 * once) and then sorted into the canonical `LISTING_OWNED_BY_VALUES` order, so
 * `?owned=trans,women` and `?owned=women&owned=trans` are the same request.
 * An unknown value is kept, after the known ones, so `@IsIn` answers 400 for
 * it rather than the filter quietly widening.
 */
function toOwnedByList(value: unknown): unknown {
  const list = toQueryValueList(value);
  if (!Array.isArray(list)) return list;
  const known = normalizeListingOwnedBy(list as unknown[]);
  const unknown = (list as unknown[]).filter(
    (entry) => !isListingOwnedBy(entry),
  );
  return [...known, ...unknown];
}

/**
 * Optional server-side filters for the public directory grid. The frontend
 * also filters client-side (it renders a "showing X of Y" count over the full
 * set), so both are honored: omitting these returns every live listing.
 */
export class ListListingDirectoryQuery {
  /** Category slug — matches when present in the listing's `cats`. */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  cat?: string;

  /** Free-text search over name / blurb / hood. */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  q?: string;

  /**
   * When `'verified'`, restricts the grid to listings whose
   * `safeSpaceStatus` is `verified`. Omitting it returns every live listing,
   * with verified rows boosted first in the default order.
   */
  @IsOptional()
  @IsIn(['verified'])
  safe?: 'verified';

  /**
   * Opt into the paginated `Paginated<DirectoryCardDTO>` envelope
   * (`DirectoryService.listDirectory`), `PAGE_SIZE`-per-page instead of the
   * bare, `DEFAULT_LIST_LIMIT`-capped array. Omitting `page` entirely keeps
   * the original bare-array response — the frontend's whole-catalog callers
   * (venue picker, @mention suggestions, "related places") rely on that exact
   * shape and don't paginate; only the `/local/directory` grid opts in by
   * sending `page` (see `directory.api.ts#getDirectoryPage`).
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE)
  page?: number;

  /**
   * Accessibility requirements the listing must MEET, as canonical question
   * slugs (`LISTING_ACCESSIBILITY_QUESTION_SLUGS`). Repeatable, and also
   * accepted comma-joined. Multiple values are an AND: a member who needs a
   * step-free entrance and an accessible toilet needs both, not either.
   *
   * A requirement matches ONLY a stored `yes`. `unknown` is not a match and
   * `no` is not a match, and the two stay different everywhere downstream:
   * the card still carries all three answers so the reader can see which of
   * their requirements this place has actually answered. Promoting `unknown`
   * to a match would send someone who uses a wheelchair to a venue on the
   * strength of a question nobody ever asked it, which is exactly the failure
   * the three-valued model was built to end.
   */
  @IsOptional()
  @Transform(({ value }) => toQueryValueList(value))
  @IsArray()
  @ArrayMaxSize(LISTING_ACCESSIBILITY_QUESTION_SLUGS.length)
  @IsIn(LISTING_ACCESSIBILITY_QUESTION_SLUGS as readonly string[], {
    each: true,
  })
  access?: ListingAccessibilityQuestionSlug[];

  /**
   * Who owns the business, as its owner declared it (`LISTING_OWNED_BY_VALUES`:
   * `women`, `trans`, `nonbinary`, `bipoc`). Repeatable, and also accepted
   * comma-joined, like `access`. Several values are an OR: a listing matches
   * when its `ownedBy` holds ANY of them, because someone looking for
   * businesses run by women or by trans people wants both sets.
   *
   * Self-declared, never verified. An unknown value is a 400 rather than an
   * ignored filter, so a client never reads an unfiltered grid as a filtered
   * one. Applied in the query itself, so the paginated `total` counts only
   * matching rows.
   */
  @IsOptional()
  @Transform(({ value }) => toOwnedByList(value))
  @IsArray()
  @ArrayMaxSize(LISTING_OWNED_BY_VALUES.length)
  @IsIn(LISTING_OWNED_BY_VALUES as readonly string[], { each: true })
  owned?: ListingOwnedBy[];
}
