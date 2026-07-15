import {
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';

export type DsarArticleInput = 15 | 16 | 17 | 21;

export class SubmitDsarDto {
  @IsIn([15, 16, 17, 21])
  article: DsarArticleInput;

  @IsArray()
  @IsString({ each: true })
  scopes: string[];

  @IsString()
  @MinLength(1)
  details: string;

  @IsOptional()
  @IsString()
  context?: string;

  @IsString()
  @MinLength(1)
  reauthToken: string;
}
