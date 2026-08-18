import { IsBoolean } from 'class-validator';

/** `PATCH /listings/:ref/queer-owned-verified` body — moderator/admin-only
 * (see `ListingsController`). Mirrors `UpdateSafeSpaceDto`'s shape for a
 * single-field moderator toggle. */
export class UpdateQueerOwnedVerifiedDto {
  @IsBoolean()
  verified!: boolean;
}
