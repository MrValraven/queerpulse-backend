import { Type } from 'class-transformer';
import {
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { StudioPaymentMethodKind } from '../entities/studio-payment-method.entity';
import { STUDIO_PURCHASE_LIMITS } from '../studio-purchase-rules';

/** One payment method row; the service normalises the value for its kind. */
export class StudioPaymentMethodInputDto {
  @IsEnum(StudioPaymentMethodKind)
  kind!: StudioPaymentMethodKind;

  @IsString()
  @MaxLength(STUDIO_PURCHASE_LIMITS.paymentValueMaxLength)
  value!: string;

  @IsOptional()
  @IsString()
  @MaxLength(STUDIO_PURCHASE_LIMITS.paymentLabelMaxLength)
  label?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(STUDIO_PURCHASE_LIMITS.paymentNoteMaxLength)
  note?: string | null;
}

/** `PUT /studio/artists/:subprofileId/payment-methods`: replaces the whole
 *  list in array order. The limit of 8 rows is the service's to answer
 *  (`studio_payment_methods_limit`), so the body takes any length here. */
export class ReplaceStudioPaymentMethodsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => StudioPaymentMethodInputDto)
  methods!: StudioPaymentMethodInputDto[];
}
