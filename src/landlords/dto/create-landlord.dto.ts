import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { IsImageReference } from '../../common/validators/is-image-reference.decorator';

export class LandlordStatDto {
  @IsString() @MaxLength(40) value: string;
  @IsString() @MaxLength(80) label: string;
}

/** POST /landlords (member suggest) and POST /admin/landlords (admin create). */
export class CreateLandlordDto {
  @IsString() @MinLength(1) @MaxLength(160) name: string;

  @IsOptional() @IsString() @MaxLength(160) hood?: string;

  @IsOptional() @IsImageReference() photo?: string;

  @IsOptional() @IsString() @MaxLength(300) tagline?: string;

  @IsOptional() @IsString() @MaxLength(400) note?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @MaxLength(2000, { each: true })
  about?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(12)
  @IsString({ each: true })
  @MaxLength(160, { each: true })
  areas?: string[];

  @IsOptional() @IsString() @MaxLength(2000) rentingNote?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @ValidateNested({ each: true })
  @Type(() => LandlordStatDto)
  stats?: LandlordStatDto[];
}
