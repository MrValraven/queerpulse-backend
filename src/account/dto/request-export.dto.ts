import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export type ExportFormat = 'json' | 'csv' | 'both';

export class RequestExportDto {
  // Bounded on BOTH axes: the values are persisted verbatim on the job row
  // (`data_export_job.categories`, jsonb) and drive how much of the member's
  // data gets loaded into memory, so an unbounded array of unbounded strings
  // was a free storage/CPU amplifier. The vocabulary itself is dynamic (core
  // categories plus whatever domains registered a
  // `DATA_EXPORT_CONTRIBUTORS` contribution), so membership is checked in
  // `AccountService.requestExport` against
  // `AccountExportService.knownCategories()` rather than a static `@IsIn` that
  // would drift.
  @IsArray()
  @ArrayMaxSize(32)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  categories!: string[];

  @IsIn(['json', 'csv', 'both'])
  format!: ExportFormat;

  // Required, matching DeactivateDto/RequestDeletionDto. An Art. 20 export is a
  // complete dump of everything we hold on a person, so it gets the same
  // step-up gate as the destructive flows rather than riding on the session
  // cookie alone. (The out-of-band emailed-link verification the UI copy
  // describes does not exist, so this token is the only real gate on the
  // route.) Single-use: `AccountService.assertReauth` consumes it.
  @IsString()
  @MinLength(1)
  @MaxLength(256)
  reauthToken!: string;
}
