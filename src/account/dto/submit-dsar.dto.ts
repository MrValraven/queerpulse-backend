import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export type DsarArticleInput = 15 | 16 | 17 | 21;

export class SubmitDsarDto {
  @IsIn([15, 16, 17, 21])
  article!: DsarArticleInput;

  // Every field below lands verbatim in `dsar_request` (jsonb / text /
  // varchar). Without caps a single authenticated call could persist a
  // multi-megabyte body, so each one carries the bound the column and the
  // reviewing human can actually handle.
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  scopes!: string[];

  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  details!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  context?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(256)
  reauthToken!: string;
}
