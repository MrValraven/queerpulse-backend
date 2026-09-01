import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/**
 * Body for `PATCH /companies/:slug/reviews/:reviewId` — the review's AUTHOR
 * changing their own review.
 *
 * Field-for-field identical to `CreateCompanyReviewDto`: an edit replaces the
 * whole review rather than patching parts of it, which is what the composer
 * that produced it actually submits. Repeating the bounds here rather than
 * extending the create DTO keeps the two request contracts independently
 * readable, matching the directory's `UpdateReviewDto` precedent.
 *
 * `forbidNonWhitelisted` is global, so these four names are exactly what the
 * endpoint accepts. In particular there is no way to reach `ownerReplyText`
 * from here: the employer's reply is a different person's field on the same
 * row, and an edit must never be able to erase it.
 */
export class UpdateCompanyReviewDto {
  @IsString() @MinLength(1) @MaxLength(200) title!: string;
  @IsInt() @Min(1) @Max(5) stars!: number;
  @IsString() @MinLength(1) @MaxLength(200) byline!: string;

  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(2000, { each: true })
  body!: string[];
}
