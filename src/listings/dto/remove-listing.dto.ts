import { IsOptional, IsString, MaxLength } from 'class-validator';

/** Optional body for `DELETE /admin/listings/:ref` (moderator/admin only,
 * `removeByModerator`) — captures why the listing was removed (item #15),
 * recorded on the moderation event and included in the best-effort DM to the
 * submitter. Omitted entirely when the caller sends no body (`@Body()` on a
 * `DELETE` still validates whatever is present). */
export class RemoveListingDto {
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;
}
