import { IsDateString, IsIn, IsOptional, IsString } from 'class-validator';

import { PaymentStatus } from '../entities/magazine-payment.entity';

const PAYMENT_STATUSES: PaymentStatus[] = ['agreed', 'approved_unpaid', 'paid'];

/**
 * Body of `PATCH /magazine/admin/pieces/:id/payment` (spec §7.2 Money tab).
 * Every field is optional — the 1:1 `MagazinePayment` row is created or
 * patched by `MagazinePieceService.upsertPayment`, which applies only the
 * fields present here. Mirrors `dto/update-piece.dto.ts` style.
 */
export class UpdatePaymentDto {
  @IsOptional() @IsString() fee?: string;

  @IsOptional() @IsString() expenses?: string;

  @IsOptional() @IsString() invoice?: string;

  @IsOptional() @IsDateString() filedOn?: string;

  @IsOptional() @IsString() terms?: string;

  @IsOptional() @IsDateString() dueOn?: string;

  @IsOptional() @IsIn(PAYMENT_STATUSES) status?: PaymentStatus;

  @IsOptional() @IsDateString() paidOn?: string;
}
