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

export class JobApplicationAnswerDto {
  @IsString() @MinLength(1) @MaxLength(300) question: string;
  @IsString() @MinLength(1) @MaxLength(3000) answer: string;
}

export class CreateJobApplicationDto {
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => JobApplicationAnswerDto)
  answers: JobApplicationAnswerDto[];

  @IsOptional() @IsString() @MaxLength(5000) coverNote?: string;
}
