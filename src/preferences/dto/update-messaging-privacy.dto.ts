import { IsBoolean, IsIn, IsOptional } from 'class-validator';
import { WHO_CAN_MESSAGE_VALUES, WhoCanMessage } from '../who-can-message';

/**
 * `PUT /me/messaging-privacy` (PRD-364/PRD-366): a PARTIAL update, unlike the
 * full-replace pattern `update-work-preferences.dto.ts`/
 * `update-content-sensitivity.dto.ts` use for a pane that always submits its
 * whole triple. The messaging-privacy pane instead has four INDEPENDENT,
 * instant-save toggles/choices, each firing its own PUT the instant a member
 * flips it — mirrors `UpdatePushPreviewsDto`'s single-field shape, widened to
 * four optional fields on one row so four controls can share one endpoint
 * without four routes. `PreferencesService.updateMessagingPrivacy` merges
 * whichever fields are present onto the stored row; an absent field is left
 * untouched, never reset to its default.
 */
export class UpdateMessagingPrivacyDto {
  @IsOptional()
  @IsBoolean()
  shareReadReceipts?: boolean;

  @IsOptional()
  @IsBoolean()
  shareTyping?: boolean;

  @IsOptional()
  @IsBoolean()
  sharePresence?: boolean;

  @IsOptional()
  @IsIn(WHO_CAN_MESSAGE_VALUES)
  whoCanMessage?: WhoCanMessage;
}
