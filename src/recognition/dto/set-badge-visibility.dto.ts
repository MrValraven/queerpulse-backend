import { IsBoolean } from 'class-validator';

/**
 * Body of `PATCH /me/recognition/badges/:key/visibility` (SUS-04). One field:
 * whether the member wants this earned badge hidden from how other people see
 * them. Explicit rather than a toggle so a retried request is idempotent.
 */
export class SetBadgeVisibilityDto {
  @IsBoolean()
  hiddenFromProfile!: boolean;
}
