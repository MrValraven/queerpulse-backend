import { IsIn } from 'class-validator';
import { ConversationRole } from '../entities/conversation-participant.entity';

/**
 * `PATCH /conversations/:id/members/:userId/role` body. Only `admin` or `member`
 * may be assigned here — promote a member→admin or demote an admin→member. The
 * `owner` role is never assignable via this route (succession is handled on
 * leave). OWNER ONLY (the service re-checks the caller's role).
 */
export class ChangeMemberRoleDto {
  @IsIn([ConversationRole.Admin, ConversationRole.Member])
  role: ConversationRole.Admin | ConversationRole.Member;
}
