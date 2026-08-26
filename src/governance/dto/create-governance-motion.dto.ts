import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Member `POST /governance/motions` body (GOV-01).
 *
 * Deliberately smaller than `CreateGovernanceProposalDto`: a member files the
 * QUESTION, and staff decide the rest. There is no `type` (it is always
 * `member_motion`), no `targetMemberId` (a member cannot name someone else's
 * council seat for removal without going through staff first), and no
 * `opensAt`/`closesAt` — the voting window is set by the admin who approves
 * the motion, so a proposer cannot give their own motion a two-hour window or
 * a two-year one.
 */
export class CreateGovernanceMotionDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  description!: string;
}
