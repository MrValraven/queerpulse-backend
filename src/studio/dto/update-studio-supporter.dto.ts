import { IsUUID, ValidateIf } from 'class-validator';

/** `PUT /studio/artists/:id/supporter`: the persona to show as, or `null` for the account. */
export class UpdateStudioSupporterDto {
  @ValidateIf((_body, value) => value !== null)
  @IsUUID()
  shownAsSubprofileId!: string | null;
}
