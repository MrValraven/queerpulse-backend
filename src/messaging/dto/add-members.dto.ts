import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * `POST /conversations/:id/members` body. Members are addressed by their profile
 * HANDLE (slug) — the same identifier `CreateGroupConversationDto` uses — resolved + gated
 * (connected to the adder + not blocked) server-side. Owner/admin only (the
 * service re-checks the caller's role).
 */
export class AddMembersDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(255, { each: true })
  memberHandles!: string[];
}
