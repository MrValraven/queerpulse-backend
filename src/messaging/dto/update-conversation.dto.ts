import {
  IsBoolean,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { IsImageReference } from '../../common/validators/is-image-reference.decorator';
import { ConversationMuteMode } from '../entities/conversation-participant.entity';

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

  // PRD-349: a timed mute's expiry, only meaningful alongside `muted: true`.
  // An ISO-8601 timestamp (the "8 hours"/"1 week" row-menu choices), or
  // explicit `null` for "Always" (mute forever, the pre-PRD-349 shape).
  // `@IsOptional()` skips validation for BOTH `undefined` and `null`, so only
  // a real, malformed timestamp is rejected here; `ConversationsService.
  // setMuted` does the business-logic check (strictly in the future, inside
  // the server's maximum mute duration) that a format validator can't.
  @IsOptional()
  @IsISO8601()
  mutedUntil?: string | null;

  // PRD-349: the mute MODE: `'all'` (the ordinary ladder above) or
  // `'mentionsOnly'` (never the plain "new message" push, but a push for a
  // message that `@`-mentions the caller still arrives). Independent of
  // `muted`/`mutedUntil`: a caller may set this without touching either, and
  // it is a distinct row-menu choice from the 8-hour/1-week/Always durations,
  // not a fourth duration. See `ConversationParticipant.muteMode`'s own doc.
  @IsOptional()
  @IsIn([ConversationMuteMode.All, ConversationMuteMode.MentionsOnly])
  muteMode?: ConversationMuteMode;

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

  // Mark/unmark this conversation unread (PRD-225) — a WhatsApp/Telegram/
  // Signal-style "come back to this" flag, independent of the read
  // watermark. Re-opening the thread (a genuine `POST .../read`) is the only
  // thing that clears it back.
  @IsOptional()
  @IsBoolean()
  markUnread?: boolean;

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

  // PRD-358: the group's about text. Owner/admin-gated in the service, like
  // `title`/`avatarUrl` (`updateGroup` re-checks the role and posts a
  // `group_description_changed` pill). Sanitised to plain text the same way
  // an attachment caption is (`toStoredPlainTextOrNull`) before it is ever
  // persisted, so this can never carry markup. "" clears it back to null.
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}
