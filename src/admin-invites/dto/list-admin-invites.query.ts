import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';

// The resolved-status vocabulary an admin filters by — the SAME values the rows
// display (see `AdminInviteDTO.status`), so filtering "expired" returns exactly
// the rows shown as expired, including still-pending ones past their expiry.
export const ADMIN_INVITE_STATUS_FILTERS = [
  'valid',
  'used',
  'revoked',
  'expired',
] as const;
export type AdminInviteStatusFilter =
  (typeof ADMIN_INVITE_STATUS_FILTERS)[number];

export class ListAdminInvitesQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @IsIn(ADMIN_INVITE_STATUS_FILTERS)
  status?: AdminInviteStatusFilter;

  // Partial, case-insensitive match against the invitee email the inviter typed.
  @IsOptional()
  @IsString()
  @MaxLength(255)
  email?: string;

  // Drill into a single inviter's invites (their userId).
  @IsOptional()
  @IsUUID()
  inviterId?: string;

  // Drill into a single inviter's invites by their profile slug — the handle
  // the admin UI has (the invite DTO carries the inviter's slug, not their
  // userId). Resolved to the matching inviterId in the query, so it filters the
  // whole graph server-side, not just the loaded page.
  @IsOptional()
  @IsString()
  @MaxLength(100)
  inviterSlug?: string;
}
