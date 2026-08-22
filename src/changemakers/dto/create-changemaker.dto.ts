import {
  ArrayMaxSize,
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
  @IsString() @MinLength(1) @MaxLength(200) name!: string;
  @IsString() @MinLength(1) @MaxLength(12) initials!: string;
  @IsString() @MinLength(1) @MaxLength(120) cause!: string;
  @IsIn(['coral', 'jade', 'plum']) tint!: 'coral' | 'jade' | 'plum';

  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(80, { each: true })
  tags!: string[];
  @IsString() @MaxLength(2000) summary!: string;

  // A storage key or https:// URL — never a javascript:/data: URI that another
  // member's browser would render. Matches every other image field in the repo.
  @IsOptional() @IsImageReference() imageUrl?: string;

  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(300, { each: true })
  impact!: string[];

  @IsOptional() @IsString() @MaxLength(200) byline?: string;
  @IsOptional() @IsString() @MaxLength(300) heroNote?: string;
  @IsOptional() @IsString() @MaxLength(2000) lead?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(60)
  @IsString({ each: true })
  @MaxLength(5000, { each: true })
  body?: string[];

  @IsOptional() @IsString() @MaxLength(1000) pullQuoteText?: string;
  @IsOptional() @IsString() @MaxLength(200) pullQuoteCite?: string;

  @IsOptional() @IsBoolean() isFeatured?: boolean;
  @IsOptional() @IsInt() sortOrder?: number;
}
