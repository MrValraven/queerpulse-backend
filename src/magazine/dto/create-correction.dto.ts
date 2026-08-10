import { IsDateString, IsOptional, IsString, MinLength } from 'class-validator';

/**
 * Body of `POST /magazine/admin/pieces/:id/corrections` (spec §7.2 After
 * tab). `publishedOn` defaults to today (in the service) when omitted.
 */
export class CreateCorrectionDto {
  @IsString() @MinLength(1) text!: string;

  @IsOptional() @IsDateString() publishedOn?: string;
}
