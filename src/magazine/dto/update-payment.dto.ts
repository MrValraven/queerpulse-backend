import {
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

import { PaymentStatus } from '../entities/magazine-payment.entity';
import { CURRENCY_CODE_PATTERN, MONEY_AMOUNT_PATTERN } from '../magazine-money';

const PAYMENT_STATUSES: PaymentStatus[] = ['agreed', 'approved_unpaid', 'paid'];

/**
 * Body of `PATCH /magazine/admin/pieces/:id/payment` (spec §7.2 Money tab).
 * Every field is optional — the 1:1 `MagazinePayment` row is created or
 * patched by `MagazinePieceService.upsertPayment`, which applies only the
 * fields present here. Mirrors `dto/update-piece.dto.ts` style.
 *
 * CON-18 — `fee` and `expenses` are AMOUNTS now, sent as plain decimal
 * strings ("420" or "420.50") with the currency in its own field. They land
 * in `numeric(12,2)` columns and are never parsed into a JS float on either
 * side. Anything the desk wants to say beyond the number goes in
 * `feeText`/`expensesText`, which is also where the pre-conversion free text
 * ("EUR 250", "18 travel") was preserved.
 */
export class UpdatePaymentDto {
  @IsOptional()
  @Matches(MONEY_AMOUNT_PATTERN, {
    message:
      'fee must be a plain amount like "420" or "420.50" — put the currency in `currency`',
  })
  fee?: string;

  @IsOptional() @IsString() @MaxLength(200) feeText?: string;

  @IsOptional()
  @Matches(MONEY_AMOUNT_PATTERN, {
    message:
      'expenses must be a plain amount like "18" or "18.40" — put the currency in `currency`',
  })
  expenses?: string;

  @IsOptional() @IsString() @MaxLength(200) expensesText?: string;

  @IsOptional()
  @Matches(CURRENCY_CODE_PATTERN, {
    message: 'currency must be a three-letter ISO 4217 code, e.g. EUR',
  })
  currency?: string;

  @IsOptional() @IsString() @MaxLength(120) invoice?: string;

  @IsOptional() @IsDateString() filedOn?: string;

  @IsOptional() @IsString() terms?: string;

  @IsOptional() @IsDateString() dueOn?: string;

  @IsOptional() @IsIn(PAYMENT_STATUSES) status?: PaymentStatus;

  @IsOptional() @IsDateString() paidOn?: string;
}
