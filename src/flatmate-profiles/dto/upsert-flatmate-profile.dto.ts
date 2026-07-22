import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { FlatmateProfileType } from '../entities/flatmate-profile.entity';

/** PUT /flatmate-profiles/mine body — the full desired state of my one profile
 * (create-or-replace). `type` + `budgetEuros` are required; the rest default. */
export class UpsertFlatmateProfileDto {
  @IsEnum(FlatmateProfileType) type: FlatmateProfileType;

  @IsOptional() @IsString() @MaxLength(60) pronouns?: string;

  @IsOptional() @IsString() @MaxLength(120) neighbourhood?: string;

  @IsInt() @Min(0) budgetEuros: number;

  @IsOptional() @IsDateString() moveInFrom?: string;

  @IsOptional() @IsBoolean() flexibleTiming?: boolean;

  @IsOptional() @IsString() @MaxLength(2000) about?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(12)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  lifestyleTags?: string[];
}
