import { IsInt, IsUUID, Max, MaxLength, Min, IsString } from 'class-validator';

/** POST /housing-reviews body. The author is the session user; the subject and
 * listing are derived from the completed viewing server-side. */
export class SubmitHousingReviewDto {
  // `@IsUUID()`, not a bare `@IsString()` (BE-HSG-10): the value goes straight
  // into a `uuid` column comparison, where a non-UUID string is a Postgres
  // 22P02 that surfaces as a 500 rather than the 400 it should be.
  @IsUUID() viewingId!: string;

  @IsInt() @Min(1) @Max(5) rating!: number;

  @IsString() @MaxLength(1000) text!: string;
}
