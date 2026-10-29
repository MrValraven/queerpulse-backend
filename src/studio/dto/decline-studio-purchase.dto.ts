import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { STUDIO_PURCHASE_LIMITS } from '../studio-purchase-rules';
import { trimStringValue } from './create-studio-release.dto';

/** `POST /studio/artists/:subprofileId/purchases/:purchaseId/decline`. */
export class DeclineStudioPurchaseDto {
  @IsIn(['payment_not_found', 'amount_different', 'other'])
  reason!: 'payment_not_found' | 'amount_different' | 'other';

  /** An empty note stores null (the service decides). */
  @IsOptional()
  @Transform(trimStringValue)
  @IsString()
  @MaxLength(STUDIO_PURCHASE_LIMITS.declineNoteMaxLength)
  note?: string | null;
}
