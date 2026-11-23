import { OmitType } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { CreateMembershipJoinRequestDto } from '../../../membership/dto/create-join-request.dto';

/**
 * Bodies for the two join-request code routes (SEC-10). Like the sign-in
 * bodies beside them, the code fields carry only a type check and a length
 * cap: `EmailCodeService` does the precise checks, so a bad value answers with
 * the specific reason the screen knows how to explain.
 */

/** Body for `POST /auth/email-code/join-request/request`. */
export class RequestJoinRequestEmailCodeDto {
  // No length cap: the service answers `email_invalid` past 254 characters and the global body-size limit caps the payload.
  @IsString()
  email!: string;

  /** `'pt'` sends the Portuguese email; any other value sends English. */
  @IsOptional()
  @IsString()
  @MaxLength(16)
  locale?: string;
}

/**
 * Body for `POST /auth/email-code/join-request/verify`: the join-request form
 * plus the code. It carries no `email`: the request is filed under the address
 * the code was sent to, read from the challenge, so a correct code for one
 * inbox can never file a request in another's name.
 */
export class VerifyJoinRequestEmailCodeDto extends OmitType(
  CreateMembershipJoinRequestDto,
  ['email'] as const,
) {
  @IsString()
  @MaxLength(64)
  challengeId!: string;

  @IsString()
  @MaxLength(16)
  code!: string;
}
