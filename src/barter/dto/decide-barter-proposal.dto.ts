import { IsIn } from 'class-validator';
import { BarterProposalStatus } from '../entities/barter-proposal.entity';

/**
 * Body for `PATCH /barter/:id/proposals/:proposalId`. Only the two terminal
 * states are accepted — `pending` is where a proposal starts, never somewhere
 * an owner can move it back to (mirrors `DecideSignupDto`).
 */
export class DecideBarterProposalDto {
  @IsIn([BarterProposalStatus.Accepted, BarterProposalStatus.Declined])
  status!: BarterProposalStatus.Accepted | BarterProposalStatus.Declined;
}
