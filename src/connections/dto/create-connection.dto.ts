import { IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateConnectionDto {
  @IsString()
  toSlug: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  message?: string;
}
