import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { IsImageReference } from '../../common/validators/is-image-reference.decorator';

/**
 * `PATCH /conversations/:id` body. `muted` is this caller's per-conversation
 * preference (any thread). `title`/`avatarUrl` edit a GROUP's info and are
 * owner/admin-gated server-side (`updateGroup` re-checks the role) — a title
 * change posts a `group_renamed` pill. `avatarUrl` is a storage key/URL (no new
 * upload pipeline is built here). All fields optional; at least one is expected.
 */
export class UpdateConversationDto {
  @IsOptional()
  @IsBoolean()
  muted?: boolean;

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
