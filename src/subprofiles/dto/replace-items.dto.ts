import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { IsImageReference } from '../../common/validators/is-image-reference.decorator';
import { MAX_ITEMS_PER_SECTION } from '../subprofile-validation';

// One item of a section. `section` comes from the URL, not the body (C4).
export class SubprofileItemInputDTO {
  @IsString() @MaxLength(200) title: string;

  @IsOptional() @IsString() @MaxLength(200) subtitle?: string;

  @IsOptional() @IsString() @MaxLength(5000) description?: string;

  @IsOptional() @IsString() @MaxLength(1000) url?: string;

  @IsOptional() @IsImageReference() imageUrl?: string;

  @IsOptional() @IsString() @MaxLength(40) date?: string;

  @IsOptional() @IsString() @MaxLength(200) meta?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  tags?: string[];
}

export class ReplaceItemsDTO {
  @IsArray()
  @ArrayMaxSize(MAX_ITEMS_PER_SECTION)
  @ValidateNested({ each: true })
  @Type(() => SubprofileItemInputDTO)
  items: SubprofileItemInputDTO[];
}
