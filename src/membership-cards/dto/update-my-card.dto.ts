import { IsBoolean } from 'class-validator';

/**
 * The settings a member controls on a card they HOLD, as opposed to the ones
 * the issuing community controls on the programme (`UpsertCardProgramDto`).
 */
export class UpdateMyCardDto {
  /** The member's veto over their own photo appearing on this card. */
  @IsBoolean()
  isPhotoHidden!: boolean;
}
