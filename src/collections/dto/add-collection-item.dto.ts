import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * `<kind>:<subjectId>` where the subject id is a slug or uuid. 200 is well
 * clear of the longest real ref and stops an unbounded string reaching
 * `parseSavedRef` and the `collection_item` row (CNT-19).
 */
export const COLLECTION_REF_MAX_LENGTH = 200;

/**
 * Body for `POST /me/collections/:id/items`. `ref` is the frontend's composite
 * saved-item id (`<kind>:<subjectId>`, e.g. `article:trans-health-lisbon`) —
 * the same shape `saved.api.ts` uses in the URL — decomposed server-side via
 * `parseSavedRef` into the `(subjectKind, subjectId)` the join row stores.
 */
export class AddCollectionItemDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(COLLECTION_REF_MAX_LENGTH)
  ref!: string;
}
