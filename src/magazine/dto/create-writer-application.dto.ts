import { IsOptional, IsString, IsUrl, MaxLength } from 'class-validator';

export class CreateWriterApplicationDto {
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  pitchNote?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20000)
  sampleText?: string;

  @IsOptional()
  @IsUrl()
  @MaxLength(2000)
  sampleLink?: string;
}
