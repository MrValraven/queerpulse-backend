import { IsOptional, IsString } from 'class-validator';

export class GetGovernanceFinancesQuery {
  // e.g. "2026-Q2". Omitted = most recently published report.
  @IsOptional() @IsString() quarter?: string;
}
