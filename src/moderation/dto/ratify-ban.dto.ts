import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { BanRatificationStatus } from '../entities/ban-ratification.entity';

/**
 * `PATCH /mod/ratifications/:id` body — the second moderator's signature on, or
 * refusal of, a permanent ban another moderator asked for (TS-12).
 *
 * There is no third option. A moderator who does not want to decide simply
 * leaves the hold alone, and it lapses on its own at `expiresAt`, which is the
 * outcome that fails safe for the member.
 */
export class RatifyBanDto {
  @IsIn(['ratify', 'decline'])
  decision!: 'ratify' | 'decline';

  /**
   * The ratifying moderator's own words. Optional on a ratification (the first
   * moderator's `note` is what the member reads when the ban lands) and
   * strongly wanted on a decline, where it is the record of why one moderator
   * refused another's ban. Not enforced as required: refusing to remove someone
   * must never be the harder of the two paths.
   */
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

const RATIFICATION_STATUSES = Object.values(BanRatificationStatus);

/** `GET /mod/ratifications` query. Defaults to the pending holds. */
export class ListRatificationsQuery {
  @IsOptional()
  @IsIn(RATIFICATION_STATUSES)
  status?: BanRatificationStatus;
}
