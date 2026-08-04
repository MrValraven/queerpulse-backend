import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Body for `POST /auth/onboarding/complete`. Everything is optional so a client
 * that has nothing extra to send can still POST an empty body.
 *
 * `guidelinesVersion` is the community-guidelines revision the wizard actually
 * displayed alongside the agreement checkbox. When omitted, the server stamps
 * its own `CURRENT_GUIDELINES_VERSION` instead. Capped at 32 chars to match the
 * `users.guidelines_version` column.
 */
export class CompleteOnboardingDto {
  @IsOptional()
  @IsString()
  @MaxLength(32)
  guidelinesVersion?: string;
}
