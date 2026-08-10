import {
  IsBoolean,
  IsEmail,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
} from 'class-validator';

export class CreatePressContactDto {
  @IsString()
  @MaxLength(200)
  name!: string;

  @IsString()
  @MaxLength(200)
  role!: string;

  @IsString()
  @MaxLength(2000)
  description!: string;

  @IsString()
  @MaxLength(200)
  languages!: string;

  @IsEmail()
  email!: string;

  // Nullable avatar. `@IsOptional` skips validation for both `null` and an
  // omitted value; a present value must be a real URL.
  @IsOptional()
  @IsUrl()
  avatarUrl?: string | null;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
