import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Body for `POST /communities/:slug/space-requests`: an owner or co-owner
 * asking platform staff to switch spaces on for this community. `note` is
 * optional context for the reviewer; stored through `toStoredPlainTextOrNull`
 * (see `space-requests.service.ts`), the same write-boundary sanitiser every
 * other community-authored short text in this module goes through.
 */
export class CreateSpaceRequestDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
