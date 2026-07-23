import {
  IsInt,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/** POST /landlords/:slug/recommendations — upserts my one recommendation. */
export class CreateRecommendationDto {
  @IsInt() @Min(1) @Max(5) stars: number;

  @IsString() @MinLength(10) @MaxLength(2000) text: string;
}
