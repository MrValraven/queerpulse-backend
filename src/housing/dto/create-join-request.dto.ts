import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateJoinRequestDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name: string;

  @IsString()
  @MaxLength(120)
  householdSize: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}
