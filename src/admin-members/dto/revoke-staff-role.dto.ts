import { IsString, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import {
  MAX_STAFF_ROLE_REASON_LENGTH,
  MIN_STAFF_ROLE_REASON_LENGTH,
  STAFF_ROLE_REASON_MESSAGE,
  trimmedReason,
} from './staff-role-reason';

/**
 * Body for `DELETE /admin/members/:id/staff-roles/:role` (PRD-288).
 *
 * The role itself stays in the path, unchanged, so no existing caller's URL
 * moves. Only the reason is new, and it rides in a body rather than a query
 * string: a reason can name a person and can run to a sentence, and a query
 * string is the one part of a request that ends up in access logs and browser
 * history verbatim. A DELETE with a body is already the house pattern here
 * (`admin-listings.controller.ts`, `my-media.controller.ts`).
 *
 * Required, exactly like the grant. Revocation is the half that actually takes
 * something away: it strips the grant that gates a moderator's queues, and one
 * mis-click doing that silently is the whole finding.
 */
export class RevokeStaffRoleDto {
  @ApiProperty({
    minLength: MIN_STAFF_ROLE_REASON_LENGTH,
    maxLength: MAX_STAFF_ROLE_REASON_LENGTH,
    description:
      'Why this member is losing the role. Recorded in the audit trail.',
  })
  @Transform(trimmedReason)
  @IsString()
  @MinLength(MIN_STAFF_ROLE_REASON_LENGTH, {
    message: STAFF_ROLE_REASON_MESSAGE,
  })
  @MaxLength(MAX_STAFF_ROLE_REASON_LENGTH)
  reason!: string;
}
