import { ReportStatus } from '../reports/entities/report.entity';
import { ModActionCode } from './dto/mod-action.dto';

/**
 * Maps a moderator action (`ModActionInput.action`) to the report status it
 * results in (C6). `escalate` sends the report up for further review;
 * every other action (including `dismiss`) closes it out as `resolved`.
 */
export function statusForAction(action: ModActionCode): ReportStatus {
  return action === 'escalate' ? ReportStatus.Escalated : ReportStatus.Resolved;
}
