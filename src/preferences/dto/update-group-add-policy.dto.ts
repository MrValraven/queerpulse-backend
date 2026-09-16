import { IsEnum } from 'class-validator';
import { GroupAddPolicy } from '../entities/member-preferences.entity';

/**
 * `PUT /me/group-add-policy` (PRD-353): who may put this member straight into
 * a group conversation. `connections` (default) is today's behaviour: an
 * owner/admin who is an accepted connection seats the member directly.
 * `invite_only` turns every such add into a `group_invites` row the member
 * accepts or declines instead. See `GroupAddPolicy`'s own doc for the full
 * contract, including why there is no third "everyone" value.
 */
export class UpdateGroupAddPolicyDto {
  @IsEnum(GroupAddPolicy)
  policy!: GroupAddPolicy;
}
