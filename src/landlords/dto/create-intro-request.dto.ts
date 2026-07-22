import {
  IsEmail,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/** POST /landlords/:slug/intro-requests — a stored request for moderators. */
export class CreateIntroRequestDto {
  @IsString() @MinLength(2) @MaxLength(120) name: string;

  @IsOptional() @IsString() @MaxLength(2000) note?: string;

  @IsOptional() @IsEmail() @MaxLength(200) contactEmail?: string;
}
