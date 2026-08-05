import { IsIn } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { STAFF_ROLE_IDS, StaffRoleId } from '../../users/staff-roles.registry';

/**
 * Body for `POST /admin/members/:id/staff-roles`. `@IsIn` rejects anything
 * outside `STAFF_ROLE_IDS` before the service runs, mirroring how
 * `UpdateMemberRoleDto`'s `@IsEnum` gates `updateRole`'s target role.
 */
export class GrantStaffRoleDto {
  @ApiProperty({ enum: STAFF_ROLE_IDS })
  @IsIn(STAFF_ROLE_IDS)
  role!: StaffRoleId;
}
