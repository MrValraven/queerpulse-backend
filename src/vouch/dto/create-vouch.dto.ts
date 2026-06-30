import { IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateVouchDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}
