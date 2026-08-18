import { IsInt, Min, ValidateIf } from 'class-validator';

/**
 * Body for `PATCH /admin/members/:id/invite-quota`. `quota` is the member's
 * new monthly invite allowance in full, mirroring `UpdateMemberRoleDto`'s
 * "set the value you want" shape:
 *  - a non-negative integer sets a per-member override, taking precedence
 *    over the platform-wide `INVITE_MONTHLY_QUOTA` default
 *    (`InvitesService.resolveMonthlyLimit`);
 *  - `null` clears the override, so the member falls back to that default.
 *
 * `@ValidateIf` only relaxes `@IsInt`/`@Min` when the value is exactly
 * `null` — an *absent* field still fails validation, so callers must always
 * state their intent explicitly rather than relying on "no body" to mean
 * "clear it".
 */
export class UpdateInviteQuotaDto {
  @ValidateIf((_dto, value) => value !== null)
  @IsInt()
  @Min(0)
  quota!: number | null;
}
