import { Transform } from 'class-transformer';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * `POST /admin/invites/refresh-expired` body. With no `inviterSlug` it refreshes
 * every expired invite platform-wide; with one it refreshes only the invites
 * that member sent, resolved exactly like the list query's `inviterSlug`.
 */
export class RefreshExpiredAdminInvitesDto {
  // Same validation as `ListAdminInvitesQuery.inviterSlug`, plus a trim and
  // `IsNotEmpty`: a blank slug is a 400, so only an absent one widens the
  // refresh to every inviter.
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  inviterSlug?: string;
}
