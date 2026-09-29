import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

export class HostQuestionInputDto {
  @ApiProperty()
  @IsString()
  @MaxLength(80)
  prompt!: string;

  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(4)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  options!: string[];
}

export class HostConfigDto {
  @ApiProperty()
  @IsBoolean()
  enabled!: boolean;

  @ApiPropertyOptional({
    description: 'ISO time; defaults to 48 hours before the start.',
  })
  @IsOptional()
  @IsISO8601()
  cutoffAt?: string;

  @ApiProperty({ type: [HostQuestionInputDto] })
  @IsArray()
  @ArrayMaxSize(2)
  @ValidateNested({ each: true })
  @Type(() => HostQuestionInputDto)
  hostQuestions!: HostQuestionInputDto[];

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  meetingPointNote?: string | null;
}
