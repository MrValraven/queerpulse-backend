import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { VerificationLevel, VerificationType } from '../verification-level';

/**
 * `POST /verification/requests` body. `type` is optional on the wire — the
 * service defaults it to `identity` (the only kind that exists today, see
 * `VerificationType`) — kept optional here rather than defaulted on the DTO
 * so `submitRequest`'s own default stays the single source of truth.
 *
 * `context`/`evidenceRef` are option-A, reference-based evidence (see the
 * design spec's §9): the member's own words plus a link to already-public
 * corroboration — never a document upload, so nothing special-category is
 * ever stored here.
 */
export class SubmitVerificationRequestDto {
  @IsOptional()
  @IsEnum(VerificationType)
  type?: VerificationType;

  @IsEnum(VerificationLevel)
  requestedLevel!: VerificationLevel;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  context?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  evidenceRef?: string;
}
