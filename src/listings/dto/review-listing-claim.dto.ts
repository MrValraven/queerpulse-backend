import { IsIn } from 'class-validator';

/** `PATCH /listings/admin/claims/:id` body — moderator/admin-only. Mirrors
 * `ReviewJoinRequestDto`'s shape. */
export class ReviewListingClaimDto {
  @IsIn(['approved', 'declined'])
  decision!: 'approved' | 'declined';
}
