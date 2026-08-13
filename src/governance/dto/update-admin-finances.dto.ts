import { Type } from 'class-transformer';
import {
  IsArray,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * One correction to a single income/expense ledger row, addressed by its
 * position in the array. `amount` is the pre-formatted display string the row
 * shows (e.g. "€1,840") — kept as a string because that is how the ledger is
 * stored and rendered; the tab does not re-derive it.
 */
export class FinanceLedgerEditDto {
  @IsInt()
  @Min(0)
  index!: number;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  amount?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;
}

/**
 * Partial update of the latest governance finance report's editable figures.
 * Every field is optional — the service writes and audits only the fields
 * actually present and actually changed, so saving the form untouched produces
 * no history. `surplus` is intentionally absent: it is always recomputed from
 * `incomeTotal - expenseTotal`, never set directly.
 *
 * The global ValidationPipe runs with `whitelist` + `forbidNonWhitelisted`, so
 * an unknown field is a 400 rather than a silently ignored typo.
 */
export class UpdateAdminFinancesDto {
  @IsOptional()
  @IsNumber()
  @Min(0)
  mrr?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  sustainerCount?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  solidarityRate?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  incomeTotal?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  expenseTotal?: number;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FinanceLedgerEditDto)
  income?: FinanceLedgerEditDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FinanceLedgerEditDto)
  expense?: FinanceLedgerEditDto[];

  /** Free-text reason, recorded on every audit row this request produces. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
