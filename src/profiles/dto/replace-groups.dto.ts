import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

export class GroupItemDto {
  @IsString() @MaxLength(120) groupSlug: string;
  @IsString() @MaxLength(80) role: string;
}

export class ReplaceGroupsDto {
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => GroupItemDto)
  items: GroupItemDto[];
}
