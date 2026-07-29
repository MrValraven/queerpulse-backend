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
import { IsImageReference } from '../../common/validators/is-image-reference.decorator';

export class CreateChangemakerDto {
  @IsString() @MinLength(1) @MaxLength(200) name: string;
  @IsString() @MinLength(1) @MaxLength(12) initials: string;
  @IsString() @MinLength(1) @MaxLength(120) cause: string;
  @IsIn(['coral', 'jade', 'plum']) tint: 'coral' | 'jade' | 'plum';

  @IsArray() @IsString({ each: true }) tags: string[];
  @IsString() @MaxLength(2000) summary: string;

  // A storage key or https:// URL — never a javascript:/data: URI that another
  // member's browser would render. Matches every other image field in the repo.
  @IsOptional() @IsImageReference() imageUrl?: string;

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
