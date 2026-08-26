import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { IsImageReference } from '../../common/validators/is-image-reference.decorator';

/**
 * `PATCH /conversations/:id` body. `muted`, `pinned`, `favorite` and `archived`
 * are this caller's per-conversation preferences (any thread); a single PATCH
 * may carry one or more of them. `draft` is this caller's own unsent composer
 * text for the conversation, synced (debounced client-side) so it survives a
 * device switch. `title`/`avatarUrl` edit a GROUP's info and are owner/admin-
 * gated server-side (`updateGroup` re-checks the role) — a title change posts a
 * `group_renamed` pill. `avatarUrl` is a storage key/URL (no new upload
 * pipeline is built here). All fields optional; at least one is expected.
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

  // Archive/unarchive this conversation out of the caller's main inbox — the
  // reversible replacement for the destructive "clear for me". Auto-cleared
  // server-side the moment a new message lands (see the entity's own doc).
  @IsOptional()
  @IsBoolean()
  archived?: boolean;

  // This caller's own unsent composer text, or "" to clear it. Same cap as a
  // sent message body (`SendMessageDto.body`) — a draft can grow to exactly
  // what it would be allowed to send. Not trimmed: a draft mid-composition may
  // legitimately end in the trailing space/newline the member is about to
  // continue typing past.
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  draft?: string;

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
