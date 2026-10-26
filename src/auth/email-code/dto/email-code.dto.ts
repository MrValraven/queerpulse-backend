import {
  IsBoolean,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

/**
 * Bodies for the four `/auth/email-code` routes. Each field carries only a type
 * check and a length cap: `EmailCodeService` does the precise checks (address
 * shape, 6-digit code, uuid challenge id), so a bad value answers with the
 * specific reason code the screen knows how to explain.
 */

/** Body for `POST /auth/email-code/request`. */
export class RequestEmailCodeDto {
  // No length cap: the service answers `email_invalid` past 254 characters and the global body-size limit caps the payload.
  @IsString()
  email!: string;

  /** `'pt'` sends the Portuguese email; any other value sends English. */
  @IsOptional()
  @IsString()
  @MaxLength(16)
  locale?: string;
}

/** Body for `POST /auth/email-code/verify`. */
export class VerifyEmailCodeDto {
  @IsString()
  @MaxLength(64)
  challengeId!: string;

  @IsString()
  @MaxLength(16)
  code!: string;

  /** The invite code a newcomer arrived with. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  invite?: string;

  @IsOptional()
  @IsBoolean()
  ageAttested?: boolean;

  @IsOptional()
  @Matches(/^[0-9A-Za-z.-]{1,32}$/)
  termsVersion?: string;

  /** Where to land after signing in; checked by `resolvePostLoginRedirect`. */
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  redirect?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  firstName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  lastName?: string;
}

/** Body for `POST /auth/email-code/reauth/request`. */
export class ReauthEmailCodeRequestDto {
  /** `'pt'` sends the Portuguese email; any other value sends English. */
  @IsOptional()
  @IsString()
  @MaxLength(16)
  locale?: string;
}

/** Body for `POST /auth/email-code/reauth/verify`. */
export class ReauthEmailCodeVerifyDto {
  @IsString()
  @MaxLength(64)
  challengeId!: string;

  @IsString()
  @MaxLength(16)
  code!: string;
}
