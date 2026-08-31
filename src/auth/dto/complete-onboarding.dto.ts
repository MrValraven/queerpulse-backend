import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Body for `POST /auth/onboarding/complete`. Everything is optional so a client
 * that has nothing extra to send can still POST an empty body.
 *
 * `guidelinesVersion` is the community-guidelines revision the wizard displayed
 * alongside the agreement checkbox. It is ACCEPTED AND IGNORED: `markOnboarded`
 * always stamps the server's own `CURRENT_GUIDELINES_VERSION`, because the
 * consent record is the platform's evidence that a member agreed to a revision
 * it was actually serving, and a value taken from the body is a string the
 * client chose (ENG-23). The field stays on the DTO because
 * `forbidNonWhitelisted` is on globally, so removing it would start rejecting
 * every client still sending it. Capped at 32 chars to match the
 * `users.guidelines_version` column.
 */
export class CompleteOnboardingDto {
  @IsOptional()
  @IsString()
  @MaxLength(32)
  guidelinesVersion?: string;
}
