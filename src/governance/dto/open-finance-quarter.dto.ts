import { IsString, Matches } from 'class-validator';

/**
 * PRD-447. Opens an empty finance report for a quarter, so the governance
 * team can enter real figures once the seeded report is gone. `quarter` uses
 * the stored "2026-Q3" form.
 */
export class OpenFinanceQuarterDto {
  @IsString()
  @Matches(/^\d{4}-Q[1-4]$/, {
    message: 'quarter must look like 2026-Q3',
  })
  quarter!: string;
}
