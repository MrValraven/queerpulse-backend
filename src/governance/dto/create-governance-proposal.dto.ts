import {
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { GovernanceProposalType } from '../entities/governance-proposal.entity';

// Admin `POST /governance/proposals` body. `targetMemberId` is required (and
// only meaningful) when `type` is `council_removal` — enforced in the
// service, since class-validator's conditional decorators can't express
// "required if a sibling field equals X" cleanly against an enum.
export class CreateGovernanceProposalDto {
  @IsEnum(GovernanceProposalType)
  type!: GovernanceProposalType;

  @IsString()
  @MaxLength(200)
  title!: string;

  @IsString()
  @MaxLength(2000)
  description!: string;

  @IsOptional()
  @IsUUID()
  targetMemberId?: string;

  @IsDateString()
  opensAt!: string;

  @IsDateString()
  closesAt!: string;
}
