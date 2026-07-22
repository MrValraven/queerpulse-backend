import { IsInt, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

/** Body for `POST /directory/:slug/reviews` — a member leaving a review. */
export class CreateReviewDto {
  @IsInt()
  @Min(1)
  @Max(5)
  stars: number;

  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  text: string;
}
