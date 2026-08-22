import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
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

  // NOTE: `memberCount` is deliberately NOT accepted here. It used to be an
  // admin-typed integer while `computeMutualConnections` already treated
  // approved join requests as the real roster, so the public "N members" figure
  // was whatever a steward last typed. It is now derived from the roster in
  // `HousingGroupsService.refreshMemberCount`.

  @IsOptional()
  @IsBoolean()
  published?: boolean;
}
