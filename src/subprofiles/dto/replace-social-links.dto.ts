import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

class SocialLinkInputDTO {
  @IsString()
  platform: string;

  @IsString()
  @MaxLength(300)
  urlOrHandle: string;
}

export class ReplaceSocialLinksDTO {
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => SocialLinkInputDTO)
  items: SocialLinkInputDTO[];
}
