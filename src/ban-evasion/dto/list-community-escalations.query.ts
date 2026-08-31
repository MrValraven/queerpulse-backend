import { IsEnum, IsOptional } from 'class-validator';
import { BanEvasionEscalationStatus } from '../entities/ban-evasion-escalation.entity';

/**
 * `GET /communities/:slug/join-requests/escalations?status=open`.
 *
 * OMITTING `status` returns both open and resolved, which is the default this
 * surface wants: a triage screen renders "escalated" on an open one, and it
 * needs the resolved ones in the same pass to know that a closed case may be
 * escalated again. Filtering exists for a client that wants one lane.
 *
 * Deliberately a separate class from `ListBanEvasionEscalationsQuery`, which
 * backs the staff console and defaults to the OPEN queue because that is what
 * staff are on shift for. Two surfaces, two defaults, so neither can be changed
 * by accident while editing the other.
 */
export class ListCommunityEscalationsQuery {
  @IsOptional()
  @IsEnum(BanEvasionEscalationStatus)
  status?: BanEvasionEscalationStatus;
}
