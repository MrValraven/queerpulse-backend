import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { IsImageReference } from '../../common/validators/is-image-reference.decorator';

/**
 * `POST /conversations/group` body. Members are addressed by their profile
 * HANDLE (slug) — the same identifier `CreateConversationDto` uses for a DM —
 * which the service resolves to user ids and gates (connected + not blocked).
 * `avatarUrl` is an optional storage key/URL for the group photo (Phase 1 leaves
 * it optional; cohost upload UI is deferred).
 */
export class CreateGroupConversationDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  title!: string;

  // A storage key or https:// URL — the IsImageReference guard refuses a
  // javascript:/data: URI that group members' browsers would otherwise render.
  @IsOptional()
  @IsImageReference()
  avatarUrl?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(255, { each: true })
  memberHandles!: string[];
}
