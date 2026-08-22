import { Transform } from 'class-transformer';
import { IsBoolean, IsNotEmpty, IsOptional, IsString } from 'class-validator';

// Admin `DELETE /admin/media` query. Same `{ key }` shape as
// `AdminMediaHeadQueryDto`, kept a distinct class so the destructive route's
// contract reads honestly at the call site rather than borrowing the head
// endpoint's DTO. `AdminMediaService.delete` re-validates the key against the
// known-key posture before the object is touched.
export class AdminMediaDeleteQueryDto {
  @IsString()
  @IsNotEmpty()
  key!: string;

  /**
   * Delete even though the object is still referenced (or the reference check
   * is degraded). Off by default — see `AdminMediaService.delete` for why an
   * override exists here and deliberately does not on `/me/media`. Every use
   * is logged with the references it overrode.
   *
   * Query params arrive as strings, so only the exact literal `"true"` opts
   * in; anything else (including `"1"`, `""`, a repeated param arriving as an
   * array) stays `false` rather than being coerced truthy.
   */
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  force?: boolean;
}
