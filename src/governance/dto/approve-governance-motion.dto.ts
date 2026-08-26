import { IsDateString, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Admin `POST /admin/governance/motions/:id/approve` body (GOV-01): the
 * voting window staff are granting the motion. `closesAt` must be after
 * `opensAt`, validated in the service exactly as `createProposal` does it,
 * since class-validator cannot compare two sibling fields cleanly.
 *
 * `note` is optional here (it is required on a rejection) — an approval
 * explains itself.
 */
export class ApproveGovernanceMotionDto {
  @IsDateString()
  opensAt!: string;

  @IsDateString()
  closesAt!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}
