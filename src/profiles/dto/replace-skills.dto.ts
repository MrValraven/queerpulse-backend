import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

export class SkillItemDto {
  @IsString() @MaxLength(120) name: string;
  @IsString() @MaxLength(200) meta: string;
}

export class ReplaceSkillsDto {
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => SkillItemDto)
  items: SkillItemDto[];
}
