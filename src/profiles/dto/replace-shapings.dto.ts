import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { ShapingKind } from '../entities/shaping.entity';

export class ShapingItemDto {
  @IsEnum(ShapingKind) kind: ShapingKind;
  @IsString() @MaxLength(200) title: string;
  @IsString() @MaxLength(500) note: string;
}

export class ReplaceShapingsDto {
  @IsArray()
  @ArrayMaxSize(4)
  @ValidateNested({ each: true })
  @Type(() => ShapingItemDto)
  items: ShapingItemDto[];
}
