import { IsEnum, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { CommunityJoinRequestDeclineKind } from '../entities/community-join-request.entity';

export class TriageCommunityJoinRequestDto {
  @IsIn(['approve', 'decline'])
  action!: 'approve' | 'decline';

  /**
   * Which kind of "no" a decline is (see `CommunityJoinRequestDeclineKind`).
   * Ignored on approve. Optional rather than required on decline, so a client
   * that predates this field still declines successfully: the decline is then
   * recorded with no kind and no reapply wait, which is exactly how the entity
   * tells readers to treat a decline that carries no kind.
   */
  @IsOptional()
  @IsEnum(CommunityJoinRequestDeclineKind)
  declineKind?: CommunityJoinRequestDeclineKind;

  /**
   * The reviewer's own words for the applicant, persisted to
   * `community_join_requests.decline_reason`. Applicant-facing by design (see
   * that column's docstring); moderator-only working notes belong in
   * `internalNote`, which no response or notification ever carries.
   */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  declineReason?: string;
}
