import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateChangemakerDto {
  @IsString() @MinLength(1) @MaxLength(200) name: string;
  @IsString() @MinLength(1) @MaxLength(12) initials: string;
  @IsString() @MinLength(1) @MaxLength(120) cause: string;
  @IsIn(['coral', 'jade', 'plum']) tint: 'coral' | 'jade' | 'plum';

  @IsArray() @IsString({ each: true }) tags: string[];
  @IsString() @MaxLength(2000) summary: string;

  @IsOptional() @IsString() @MaxLength(500) imageUrl?: string;

  @IsArray() @IsString({ each: true }) impact: string[];

  @IsOptional() @IsString() @MaxLength(200) byline?: string;
  @IsOptional() @IsString() @MaxLength(300) heroNote?: string;
  @IsOptional() @IsString() lead?: string;

  @IsOptional() @IsArray() @IsString({ each: true }) body?: string[];

  @IsOptional() @IsString() pullQuoteText?: string;
  @IsOptional() @IsString() @MaxLength(200) pullQuoteCite?: string;

  @IsOptional() @IsBoolean() isFeatured?: boolean;
  @IsOptional() @IsInt() sortOrder?: number;
}
