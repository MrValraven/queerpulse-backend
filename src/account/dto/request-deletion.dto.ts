import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class RequestDeletionDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;

  @IsString()
  @MinLength(1)
  reauthToken: string;
}
