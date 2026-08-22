import { IsISO8601, IsOptional, IsUUID } from 'class-validator';

/**
 * Body of `POST /conversations/:id/read`. Every field is optional: an empty
 * body still means "read up to now", which is what the endpoint did before it
 * accepted a body at all.
 */
export class MarkReadDto {
  /**
   * The newest message the client actually rendered. The server reads that
   * row's own `created_at` and uses it as the watermark, so the receipt can
   * never claim more than the reader was shown. Prefer this over `lastReadAt`.
   */
  @IsOptional()
  @IsUUID('4')
  upToMessageId?: string;

  /**
   * Legacy client-clock watermark (the web app sends `new Date()` here). Kept
   * so an already-deployed client keeps working; the server clamps it to
   * `now()` and only ever moves the watermark forward.
   */
  @IsOptional()
  @IsISO8601()
  lastReadAt?: string;
}
