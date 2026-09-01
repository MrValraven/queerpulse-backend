import { IsInt, IsString, Max, MaxLength, Min } from 'class-validator';

/**
 * Body for `PATCH /housing-reviews/:reviewId` — the AUTHOR changing their own
 * review.
 *
 * WHY AN EDIT PATH EXISTS AT ALL. A member gets exactly one review per listing
 * (`UQ_housing_reviews_listing_author`), so without this the one review someone
 * ever wrote about a home stood unchanged forever: a complaint about something
 * the lister then fixed, a rating written in the wrong week, a typo. The
 * one-review rule is worth keeping, and this is what makes it fair to keep. It
 * is the same trade the business directory made in
 * `DirectoryService.updateReview`.
 *
 * WHEN IT CAN BE USED: only while the review is still BLIND. Edits close the
 * moment the review reveals, which is the moment it acquires a reader, so a
 * member can correct their words right up until they go public and not after.
 * Left open past reveal it would have ended blindness by the back door: a guest
 * could read the lister's review of them and only then settle their own rating.
 * A revealed review answers this endpoint with a 409, distinct from the 403 for
 * somebody else's review and the 404 for one that does not exist.
 *
 * WHAT IT DOES NOT DO: it never clears the lister's reply. See
 * `HousingReviewsService.updateOwnReview` for the whole rule.
 *
 * Bounds mirror `SubmitHousingReviewDto` exactly, so an edit can never store a
 * value a submission could not. `text` has no minimum there and none here: a
 * rating with no words is a legitimate review on this surface.
 */
export class UpdateHousingReviewDto {
  @IsInt() @Min(1) @Max(5) rating!: number;

  @IsString() @MaxLength(1000) text!: string;
}
