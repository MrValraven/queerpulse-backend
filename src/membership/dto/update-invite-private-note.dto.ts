import { IsString, MaxLength, ValidateIf } from 'class-validator';

/**
 * Body of `PATCH /invites/:code/private-note`: the inviter's own label on one
 * of their invites, replacing whatever was there.
 *
 * `privateNote` is always required. `null` clears it, and so does an empty or
 * whitespace-only string, since the service stores blank as NULL. `@ValidateIf`
 * skips the string checks for exactly `null`, so a missing key still fails.
 *
 * The 120-character cap is measured on the raw input, before the service
 * trims, so the stored value can only be shorter.
 */
export class UpdateInvitePrivateNoteDto {
  @ValidateIf((_object, value) => value !== null)
  @IsString()
  @MaxLength(120)
  privateNote!: string | null;
}
