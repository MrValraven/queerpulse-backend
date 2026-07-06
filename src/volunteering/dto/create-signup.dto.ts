import { IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateSignupDto {
  @IsOptional() @IsString() @MaxLength(2000) note?: string;
}
