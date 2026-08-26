import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { MAX_COMMUNITY_BAN_DAYS } from './remove-member.query';

/**
 * Body of `PATCH /communities/:slug/bans/:memberSlug` (owner, co-owner or
 * moderator).
 *
 * The route exists so a ban already in place can be revised without being
 * lifted and reapplied. Three things a moderator needs to be able to change
 * after the fact:
 *
 *  - put an end date on a permanent ban, which is how every ban written before
 *    timed bans existed becomes something other than a life sentence;
 *  - shorten or extend one that already has an end date;
 *  - attach or correct the house rule the ban rests on (TS-15), including on a
 *    ban that predates rule citation entirely.
 *
 * Every field is optional and only the fields present are written, so a client
 * changing the expiry never has to resend the reason and risk clobbering
 * another moderator's edit with a stale copy of it.
 */
export class UpdateCommunityBanDto {
  /**
   * How many days from now the bar should run. Send `makePermanent: true`
   * instead to clear an end date; the two are mutually exclusive, and a
   * request carrying both is refused rather than silently resolved one way.
   */
  @ValidateIf((dto: UpdateCommunityBanDto) => dto.banDays !== undefined)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_COMMUNITY_BAN_DAYS)
  banDays?: number;

  /** Clear the end date, so the bar stands until a moderator lifts it. */
  @IsOptional()
  @IsBoolean()
  makePermanent?: boolean;

  /**
   * The moderator's note. It is shown on the ban list and sent to the barred
   * member, so editing it edits what they were told; the member is notified
   * again when it changes.
   */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  /**
   * Cite one of the community's current house rules, 0-based into
   * `Community.rules`. The server snapshots the version and the rule's exact
   * wording alongside the index, so the record survives a later rewrite.
   */
  @ValidateIf((dto: UpdateCommunityBanDto) => dto.ruleIndex !== undefined)
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(199)
  ruleIndex?: number;

  /** Drop the citation entirely, for a rule cited in error. */
  @IsOptional()
  @IsBoolean()
  clearRule?: boolean;
}
