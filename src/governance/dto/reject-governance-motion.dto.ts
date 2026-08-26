import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Admin `POST /admin/governance/motions/:id/reject` body (GOV-01).
 *
 * The note is REQUIRED. A motion that ten members put their names to and that
 * staff then decline without a word is exactly the opaque decision this
 * module's whole transparency promise exists to rule out, so the reason is
 * part of the action rather than an optional extra.
 */
export class RejectGovernanceMotionDto {
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  note!: string;
}
