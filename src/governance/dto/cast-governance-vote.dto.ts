import { IsEnum } from 'class-validator';
import { GovernanceVoteChoice } from '../entities/governance-vote.entity';

// Member `POST /governance/proposals/:id/vote` body — the proposal id comes
// from the route param, not the body. Idempotent: voting twice is a no-op,
// not an error (see `GovernanceProposalService.castVote`).
export class CastGovernanceVoteDto {
  @IsEnum(GovernanceVoteChoice)
  choice!: GovernanceVoteChoice;
}
