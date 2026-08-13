import { IsIn } from 'class-validator';
import { CONCERN_TRIAGE_STATUSES, ConcernTriageStatus } from '../intake-kinds';

/**
 * Body for `PATCH /intakes/:id` — the admin triage action on a concern. Only the
 * forward triage states are accepted (`reviewing` / `resolved` / `dismissed`);
 * `new` is the state a row is created in, never something an admin sets back to.
 * The global `ValidationPipe` (`whitelist` + `forbidNonWhitelisted`) rejects any
 * other top-level key.
 */
export class UpdateIntakeStatusDto {
  @IsIn(CONCERN_TRIAGE_STATUSES)
  status!: ConcernTriageStatus;
}
