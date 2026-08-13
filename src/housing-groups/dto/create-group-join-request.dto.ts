import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

/** One submitted answer, keyed to a screening question by its id. */
export class GroupScreeningAnswerDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  questionId!: string;

  @IsString()
  @MaxLength(2000)
  answer!: string;
}

export class CreateGroupJoinRequestDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  /** The applicant's relationship to the LGBTQ+ community (the trust prompt). */
  @IsString()
  @MinLength(2)
  @MaxLength(2000)
  relationship!: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => GroupScreeningAnswerDto)
  @ArrayMaxSize(12)
  answers?: GroupScreeningAnswerDto[];

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}
