import { IsEnum, IsOptional } from 'class-validator';
import { GovernanceProposalStatus } from '../entities/governance-proposal.entity';

/**
 * Admin `GET /admin/governance/motions` query (GOV-01). Omitting `status`
 * lists every member motion whatever state it is in; the staff queue itself
 * asks for `?status=screening`.
 */
export class ListGovernanceMotionsQuery {
  @IsOptional()
  @IsEnum(GovernanceProposalStatus)
  status?: GovernanceProposalStatus;
}
