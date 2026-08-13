import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { IsImageReference } from '../../common/validators/is-image-reference.decorator';

/**
 * `PATCH /conversations/:id` body. `muted`, `pinned` and `favorite` are this
 * caller's per-conversation preferences (any thread); a single PATCH may carry
 * one or more of them. `title`/`avatarUrl` edit a GROUP's info and are
 * owner/admin-gated server-side (`updateGroup` re-checks the role) — a title
 * change posts a `group_renamed` pill. `avatarUrl` is a storage key/URL (no new
 * upload pipeline is built here). All fields optional; at least one is expected.
 */
export class UpdateConversationDto {
  @IsOptional()
  @IsBoolean()
  muted?: boolean;

  // Pin/unpin this conversation to the top of the caller's own inbox. Capped at
  // 3 pinned conversations per user server-side (409 on the 4th).
  @IsOptional()
  @IsBoolean()
  pinned?: boolean;

  @IsOptional()
  @IsBoolean()
  favorite?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  title?: string;

  // A storage key or https:// URL — the IsImageReference guard refuses a
  // javascript:/data: URI that group members' browsers would otherwise render.
  @IsOptional()
  @IsImageReference()
  avatarUrl?: string;
}
