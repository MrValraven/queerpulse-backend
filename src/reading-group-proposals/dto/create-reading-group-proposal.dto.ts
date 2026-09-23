import {
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ReadingGroupProposalFormat } from '../entities/reading-group-proposal.entity';

export class CreateReadingGroupProposalDto {
  @IsOptional() @IsString() @MaxLength(200) clubName?: string;

  // `@MinLength(1)` alone passes "   ", and a blank book with no club name
  // would name the approved community with an empty string, so `@Matches(/\S/)`
  // requires one visible character. `clubName` keeps its plain rules: a blank
  // club name trims to null and the book names the community instead.
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  @Matches(/\S/, { message: 'book needs a title' })
  book!: string;

  @IsOptional() @IsString() @MaxLength(500) why?: string;

  @IsEnum(ReadingGroupProposalFormat) format!: ReadingGroupProposalFormat;

  @IsInt() @IsIn([4, 6, 8]) maxPeople!: number;
}
