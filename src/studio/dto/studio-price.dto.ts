import { IsIn, IsInt, Max, Min } from 'class-validator';
import { STUDIO_PURCHASE_LIMITS } from '../studio-purchase-rules';

/** A price on a release or a track (`price` on both PATCH bodies). */
export class StudioPriceDto {
  @IsIn(['fixed', 'name_your_price'])
  mode!: 'fixed' | 'name_your_price';

  /** Fixed: the price. Name your price: the minimum. */
  @IsInt()
  @Min(0)
  @Max(STUDIO_PURCHASE_LIMITS.priceMaxCents)
  amountCents!: number;
}
