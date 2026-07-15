import { IsString, MaxLength, MinLength } from 'class-validator';

export class CreateConversationDto {
  // A member's `slug` — the frontend calls this a "handle", this backend's
  // Profile lookup convention is `slug` (see `profiles`/`vouch`/`connections`).
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  recipientHandle: string;
}
