import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { MAX_LEGAL_REQUEST_TEXT_LENGTH } from './create-legal-request.dto';

/**
 * Body for `POST /admin/legal-requests/:id/void`.
 *
 * The reason is required, with no default and no empty string. Voiding is the
 * only way a record leaves the published figures, so the register has to say
 * why every time it happens. The row itself is never deleted, and the public
 * report publishes how many records were voided in the period, so a struck
 * record is visible as a struck record rather than as an absence.
 */
export class VoidLegalRequestDto {
  @IsString()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @MinLength(1)
  @MaxLength(MAX_LEGAL_REQUEST_TEXT_LENGTH)
  reason!: string;
}
