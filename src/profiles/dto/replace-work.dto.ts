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

export class WorkItemDto {
  @IsString() @MaxLength(80) category: string;
  @IsString() @MaxLength(200) title: string;
  @IsString() @MaxLength(20) year: string;
  @IsOptional() @IsImageReference() imageUrl?: string;
}

export class ReplaceWorkDto {
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => WorkItemDto)
  items: WorkItemDto[];
}
