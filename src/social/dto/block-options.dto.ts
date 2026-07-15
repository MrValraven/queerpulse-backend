import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Optional body for `POST /blocks/:slug` (spec §3 Tier 1 "social";
 * `BlockOptions` in `social.api.ts`).
 */
export class BlockOptionsDto {
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;

  // Drives the FE's "also report" affordance. When true, `blockMember` also
  // files a companion report against the blocked member via `ReportsService`
  // (subjectType `user`), using `reason` (or a default) as the report reason.
  @IsOptional()
  @IsBoolean()
  alsoReport?: boolean;
}
