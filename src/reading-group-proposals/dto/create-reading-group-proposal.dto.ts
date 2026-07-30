import {
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ReadingGroupProposalFormat } from '../entities/reading-group-proposal.entity';

export class CreateReadingGroupProposalDto {
  @IsString() @MinLength(1) @MaxLength(200) book: string;

  @IsOptional() @IsString() @MaxLength(500) why?: string;

  @IsEnum(ReadingGroupProposalFormat) format: ReadingGroupProposalFormat;

  @IsInt() @IsIn([4, 6, 8]) maxPeople: number;
}
