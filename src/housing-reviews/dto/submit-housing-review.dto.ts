import { IsInt, IsString, Max, MaxLength, Min } from 'class-validator';

/** POST /housing-reviews body. The author is the session user; the subject and
 * listing are derived from the completed viewing server-side. */
export class SubmitHousingReviewDto {
  @IsString() viewingId!: string;

  @IsInt() @Min(1) @Max(5) rating!: number;

  @IsString() @MaxLength(1000) text!: string;
}
