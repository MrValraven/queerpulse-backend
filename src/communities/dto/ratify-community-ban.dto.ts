import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { CommunityBanRatificationStatus } from '../entities/community-ban-ratification.entity';

/**
 * `PATCH /communities/:slug/ban-ratifications/:id` body: the second
 * signature on, or the refusal of, a permanent bar another owner, co-owner or
 * moderator asked for (PRD-25).
 *
 * The vocabulary is the platform hold's (`RatifyBanDto`), deliberately: the
 * two controls are the same control at two scales, and a reader who knows one
 * should not have to learn a second set of words for the other.
 *
 * There is no third option. Someone who does not want to decide leaves the
 * hold alone and it lapses on its own at `expiresAt`, which settles the bar at
 * 30 days. That is the outcome that fails safe in both directions here: the
 * member is not barred for life by one person's judgement, and they are not
 * put straight back through the door either.
 */
export class RatifyCommunityBanDto {
  @IsIn(['ratify', 'decline'])
  decision!: 'ratify' | 'decline';

  /**
   * The second signatory's own words. Optional on a ratification (the
   * proposer's `note` is what the member reads when the bar becomes permanent)
   * and strongly wanted on a decline, where it is the record of why one
   * moderator would not sign another's permanent bar. Not enforced as
   * required: refusing to keep someone out for good must never be the harder
   * of the two paths.
   */
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

const COMMUNITY_BAN_RATIFICATION_STATUSES = Object.values(
  CommunityBanRatificationStatus,
);

/** `GET /communities/:slug/ban-ratifications` query. Defaults to the pending
 *  holds, which is the only status anyone can act on. */
export class ListCommunityBanRatificationsQuery {
  @IsOptional()
  @IsIn(COMMUNITY_BAN_RATIFICATION_STATUSES)
  status?: CommunityBanRatificationStatus;
}
