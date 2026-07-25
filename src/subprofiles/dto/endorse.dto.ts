import { IsOptional, IsString, MaxLength } from 'class-validator';

export class EndorseDTO {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;
}
