import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

export class SocialLinkDto {
  @IsString() @MaxLength(50) platform: string;
  @IsString() @MaxLength(300) urlOrHandle: string;
}

export class ReplaceSocialsDto {
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => SocialLinkDto)
  items: SocialLinkDto[];
}
