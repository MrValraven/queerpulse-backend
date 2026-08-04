import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

// The invited member's profile `slug` — the repo convention for addressing a
// member from the client (see `messaging/dto/create-conversation.dto.ts` /
// `add-members.dto.ts`), resolved to a `userId` server-side in
// `SubprofileInvitesService.invite()`. Never a raw `users.id` UUID.
export class InviteCollaboratorDTO {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  slug!: string;
}
