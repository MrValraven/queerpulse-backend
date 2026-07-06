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

export class CreateReviewDto {
  @IsString() @MinLength(1) @MaxLength(200) title: string;
  @IsInt() @Min(1) @Max(5) stars: number;
  @IsString() @MinLength(1) @MaxLength(200) byline: string;

  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(2000, { each: true })
  body: string[];
}
