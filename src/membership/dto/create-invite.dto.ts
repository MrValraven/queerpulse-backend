import { IsEmail, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateInviteDto {
  @IsOptional()
  @IsEmail()
  email?: string;

  // Personal message shown to the recipient on their invite landing page.
  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;

  // The inviter's "why I'm inviting you" message, shown to the recipient on the
  // onboarding welcome step.
  @IsOptional()
  @IsString()
  @MaxLength(280)
  vouch?: string;
}
