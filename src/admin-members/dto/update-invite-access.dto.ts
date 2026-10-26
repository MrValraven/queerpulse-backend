import { IsBoolean } from 'class-validator';

/**
 * Body for `PATCH /admin/members/:id/invite-access`. `hasInviteAccess` is the
 * member's invite access in full, mirroring `UpdateInviteQuotaDto`'s "set the
 * value you want" shape:
 *  - `false` pauses the member's invites: `InvitesService` refuses create and
 *    resend with `INVITE_ACCESS_DISABLED`, and their quota reads 0 remaining;
 *  - `true` turns them back on, so the monthly quota applies again.
 *
 * The field is required: an absent or non-boolean value fails validation, so
 * callers always state their intent explicitly.
 */
export class UpdateInviteAccessDto {
  @IsBoolean()
  hasInviteAccess!: boolean;
}
