import {
  CommissionCategory,
  CommissionInterest,
} from './entities/commission-interest.entity';

/** Shape returned by `POST /commissions/interest` — just enough for the
 * frontend's `SuccessPanel` to confirm what was sent (it already has the
 * `Commission` object client-side, so this isn't a re-fetch/list shape). */
export interface CommissionInterestResponseDTO {
  id: string;
  commissionTitle: string;
  commissionCategory: CommissionCategory;
  recipientName: string;
  message: string | null;
  createdAt: string;
}

export function toCommissionInterestResponse(
  entity: CommissionInterest,
): CommissionInterestResponseDTO {
  return {
    id: entity.id,
    commissionTitle: entity.commissionTitle,
    commissionCategory: entity.commissionCategory,
    recipientName: entity.recipientName,
    message: entity.message,
    createdAt: entity.createdAt.toISOString(),
  };
}
