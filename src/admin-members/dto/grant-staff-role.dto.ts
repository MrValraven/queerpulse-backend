import { IsIn, IsString, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { STAFF_ROLE_IDS, StaffRoleId } from '../../users/staff-roles.registry';
import {
  MAX_STAFF_ROLE_REASON_LENGTH,
  MIN_STAFF_ROLE_REASON_LENGTH,
  STAFF_ROLE_REASON_MESSAGE,
  trimmedReason,
} from './staff-role-reason';

/**
 * Body for `POST /admin/members/:id/staff-roles`. `@IsIn` rejects anything
 * outside `STAFF_ROLE_IDS` before the service runs, mirroring how
 * `UpdatePlatformMemberRoleDto`'s `@IsEnum` gates `updateRole`'s target role.
 */
export class GrantStaffRoleDto {
  @ApiProperty({ enum: STAFF_ROLE_IDS })
  @IsIn(STAFF_ROLE_IDS)
  role!: StaffRoleId;

  /**
   * Why this member is getting this grant (PRD-288). REQUIRED on the HTTP
   * surface: the grant is what opens a staff queue, and the audit row that
   * records it used to say only which role changed hands. See
   * `staff-role-reason.ts` for the bounds and why they are what they are.
   */
  @ApiProperty({
    minLength: MIN_STAFF_ROLE_REASON_LENGTH,
    maxLength: MAX_STAFF_ROLE_REASON_LENGTH,
    description:
      'Why this member is being granted the role. Recorded in the audit trail.',
  })
  @Transform(trimmedReason)
  @IsString()
  @MinLength(MIN_STAFF_ROLE_REASON_LENGTH, {
    message: STAFF_ROLE_REASON_MESSAGE,
  })
  @MaxLength(MAX_STAFF_ROLE_REASON_LENGTH)
  reason!: string;
}
