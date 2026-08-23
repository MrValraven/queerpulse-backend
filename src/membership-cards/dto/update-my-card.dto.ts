import { IsBoolean, IsOptional } from 'class-validator';

/**
 * The settings a member controls on a card they HOLD, as opposed to the ones
 * the issuing community controls on the programme (`UpsertCardProgramDto`).
 *
 * Every field is optional and absent leaves the stored value alone, the same
 * contract the programme DTO uses. A member toggling one setting must not
 * silently rewrite the other, and a client that predates a setting must not be
 * able to reset it by omitting it.
 */
export class UpdateMyCardDto {
  /** The member's veto over their own photo appearing on this card. */
  @IsOptional()
  @IsBoolean()
  isPhotoHidden?: boolean;

  /** The member's veto over their own pronouns appearing on this card. */
  @IsOptional()
  @IsBoolean()
  isPronounsHidden?: boolean;
}
