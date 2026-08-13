import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { ScreeningQuestionDto } from './screening-question.dto';

export class CreateGroupDto {
  @IsString()
  @Matches(/^[a-z0-9-]+$/)
  slug!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  nameEm?: string;

  @IsString()
  @MaxLength(120)
  city!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(2000)
  blurb!: string;

  @IsOptional()
  @IsBoolean()
  isAccessGated?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(240, { each: true })
  @ArrayMaxSize(20)
  norms?: string[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ScreeningQuestionDto)
  @ArrayMaxSize(12)
  screeningQuestions?: ScreeningQuestionDto[];

  @IsOptional()
  @IsInt()
  @Min(0)
  memberCount?: number;

  @IsOptional()
  @IsBoolean()
  published?: boolean;
}
