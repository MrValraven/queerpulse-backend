import { IsNotEmpty, IsString } from 'class-validator';

/**
 * Body for `POST /me/collections/:id/items`. `ref` is the frontend's composite
 * saved-item id (`<kind>:<subjectId>`, e.g. `article:trans-health-lisbon`) —
 * the same shape `saved.api.ts` uses in the URL — decomposed server-side via
 * `parseSavedRef` into the `(subjectKind, subjectId)` the join row stores.
 */
export class AddCollectionItemDto {
  @IsString()
  @IsNotEmpty()
  ref!: string;
}
