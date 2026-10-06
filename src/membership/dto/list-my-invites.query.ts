import { IsIn, IsOptional } from 'class-validator';
import { PaginationQuery } from '../../common/pagination.query';
import { PublicInviteStatus } from '../invite-response';

// The computed statuses `resolveInviteStatus` produces, which are the filter
// tabs on the member's "Invites you've sent" list. Filtering on the computed
// status puts a stale, not-yet-swept pending invite under the 'expired' tab,
// matching how the row itself reads.
export const MY_INVITE_STATUS_FILTERS: readonly PublicInviteStatus[] = [
  'valid',
  'used',
  'expired',
  'revoked',
];

/**
 * Query of `GET /invites`: the shared `?limit=&offset=` page plus an optional
 * `?status=` tab filter. Omitting `status` lists every invite the member sent.
 */
export class ListMyInvitesQuery extends PaginationQuery {
  @IsOptional()
  @IsIn(MY_INVITE_STATUS_FILTERS)
  status?: PublicInviteStatus;
}
