import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * `POST /conversations/group` body. Members are addressed by their profile
 * HANDLE (slug) — the same identifier `CreateConversationDto` uses for a DM —
 * which the service resolves to user ids and gates (connected + not blocked).
 * `avatarUrl` is an optional storage key/URL for the group photo (Phase 1 leaves
 * it optional; cohost upload UI is deferred).
 */
export class CreateGroupDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  title: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  avatarUrl?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(255, { each: true })
  memberHandles: string[];
}
