import { IsEnum } from 'class-validator';
import { UserRole } from '../../users/entities/user.entity';

/**
 * Body for `PATCH /admin/members/:id/role`. The target role is the member's
 * new role in full — not a delta — so granting and revoking `moderator` /
 * `admin` are the same operation from the client's point of view: set the
 * role you want. `@IsEnum` rejects anything outside `member`/`moderator`/`admin`
 * before the service runs, so the guardrails only ever see a valid target.
 */
export class UpdateMemberRoleDto {
  @IsEnum(UserRole)
  role: UserRole;
}
