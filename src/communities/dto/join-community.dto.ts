import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { CommunityJoinRequestInvolvement } from '../entities/community-join-request.entity';

export class JoinCommunityDto {
  @IsOptional() @IsString() @MaxLength(1000) note?: string;

  /**
   * How the applicant wants to take part, as one of the fixed
   * `CommunityJoinRequestInvolvement` ids. Optional: the question is optional
   * in the join modal, and a request without an answer is a normal request.
   *
   * The frontend also folds this answer into the free-text `note` today
   * (`composeJoinNote()`), and `note` keeps working exactly as before, so the
   * two can be sent together while the frontend stops double-sending.
   */
  @IsOptional()
  @IsEnum(CommunityJoinRequestInvolvement)
  involvement?: CommunityJoinRequestInvolvement;

  /**
   * The version of the community's house rules the applicant is agreeing to,
   * which must equal the community's current `rulesVersion`. Required in
   * practice for any community that HAS rules: `CommunitiesService.join`
   * refuses with a machine-readable 400
   * (`code: 'RULES_ACCEPTANCE_REQUIRED'`) otherwise, carrying the version the
   * client should re-prompt for. Optional here because a community with no
   * rules has nothing to accept.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  acceptedRulesVersion?: number;
}
