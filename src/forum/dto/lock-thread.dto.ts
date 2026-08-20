import { IsOptional, IsString, MaxLength } from 'class-validator';

// `POST /forum/threads/:slug/lock` body — an optional moderator note
// explaining why the thread was closed, surfaced on the locked banner
// (`ForumThreadResponse.lockReason`). Absent/blank means no reason was given.
export class LockThreadDto {
  @IsOptional()
  @IsString()
  @MaxLength(280)
  reason?: string;
}
