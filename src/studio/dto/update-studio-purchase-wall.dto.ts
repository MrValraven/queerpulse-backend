import { IsBoolean, IsUUID, ValidateIf } from 'class-validator';

/** `PUT /studio/purchases/:purchaseId/wall`: the wall flag and the identity
 *  to show. */
export class UpdateStudioPurchaseWallDto {
  @IsBoolean()
  isOnWall!: boolean;

  /** Required key; null shows the account. */
  @ValidateIf((_body, value) => value !== null)
  @IsUUID()
  shownAsSubprofileId!: string | null;
}
