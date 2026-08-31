import { IsEnum, IsOptional } from 'class-validator';
import { BanEvasionEscalationStatus } from '../entities/ban-evasion-escalation.entity';

/**
 * `GET /admin/ban-evasion/escalations?status=open`.
 *
 * Defaults to the open queue, which is the thing staff are actually on shift
 * for. `status=resolved` reads the history.
 */
export class ListBanEvasionEscalationsQuery {
  @IsOptional()
  @IsEnum(BanEvasionEscalationStatus)
  status?: BanEvasionEscalationStatus;
}
