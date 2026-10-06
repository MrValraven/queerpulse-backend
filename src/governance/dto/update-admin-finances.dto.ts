import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Matches,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

/**
 * One correction to a single income/expense ledger row, addressed by its
 * position in the array. `amount` is the pre-formatted display string the row
 * shows (e.g. "€1,840") — kept as a string because that is how the ledger is
 * stored and rendered; the tab does not re-derive it. `enabled` toggles
 * whether the row renders on the dashboard at all — a visibility change, not
 * a data correction, so it does not flip the row's provenance to `manual`.
 *
 * PRD-447: `label` renames the row. An `index` one past the last row (then the
 * next one, and so on) appends a new row; an appended row needs a `label` and
 * an `amount`, which the service checks.
 */
export class FinanceLedgerEditDto {
  @IsInt()
  @Min(0)
  index!: number;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  label?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  amount?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

/** One public stat tile ("€4,150 · Total expenditure · Within budget"). Plain
 *  words, shown as typed. */
export class FinanceStatEditDto {
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  n!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(80)
  l!: string;

  @IsString()
  @MaxLength(80)
  trend!: string;

  @IsBoolean()
  up!: boolean;
}

/** One "How event finances work" note: a bold lead and the sentence after it. */
export class FinanceEventNoteEditDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  title!: string;

  @IsString()
  @MaxLength(400)
  body!: string;
}

/** One disclosed restricted-grant partner. `scope` is the admin's own words
 *  for what the money is restricted to ("the Mental Health Fund"). For a
 *  partner whose translated restriction the admin left untouched, the editor
 *  sends its `scopeKey`, so the key survives the save (`replacePartners`).
 *  One of the two is required. */
export class FinancePartnerEditDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @IsNumber()
  @Min(0)
  amount!: number;

  // Required unless a `scopeKey` stands in for it; checked whenever it is sent.
  @ValidateIf(
    (partner: FinancePartnerEditDto) =>
      partner.scopeKey === undefined || partner.scope !== undefined,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  scope?: string;

  @IsOptional()
  @IsString()
  @Matches(/^governance:sections\.finances\.partnerScope\.[A-Za-z0-9]+$/)
  scopeKey?: string;
}

/** The operational reserve: what is held and what the target is, in euros. */
export class FinanceReserveEditDto {
  @IsNumber()
  @Min(0)
  current!: number;

  @IsNumber()
  @Min(0)
  target!: number;
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

  /** PRD-447. The public stat tiles, as a full replacement list. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @ValidateNested({ each: true })
  @Type(() => FinanceStatEditDto)
  stats?: FinanceStatEditDto[];

  /** PRD-447. The "How event finances work" notes, as a full replacement. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(12)
  @ValidateNested({ each: true })
  @Type(() => FinanceEventNoteEditDto)
  eventNotes?: FinanceEventNoteEditDto[];

  /** PRD-447. The disclosed partners, as a full replacement list. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(12)
  @ValidateNested({ each: true })
  @Type(() => FinancePartnerEditDto)
  partners?: FinancePartnerEditDto[];

  /** PRD-447. The operational reserve. `null` clears it; absent leaves it. */
  @IsOptional()
  @ValidateNested()
  @Type(() => FinanceReserveEditDto)
  reserve?: FinanceReserveEditDto | null;

  /** Free-text reason, recorded on every audit row this request produces. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
