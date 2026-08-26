import { IsIn } from 'class-validator';
import { ADMIN_TRIAGE_STATUSES, AdminTriageStatus } from '../intake-kinds';

/**
 * Body for `PATCH /intakes/:id` — the admin triage action on any submission.
 *
 * Accepts the concern worklist's `reviewing` / `resolved` / `dismissed` AND the
 * plain `reviewed` the other eleven kinds need to be cleared from the queue
 * (see {@link ADMIN_TRIAGE_STATUSES}). `new` is deliberately not accepted: it
 * is the state a row is created in, never something an admin sets back to.
 * The global `ValidationPipe` (`whitelist` + `forbidNonWhitelisted`) rejects any
 * other top-level key.
 */
export class UpdateIntakeStatusDto {
  @IsIn(ADMIN_TRIAGE_STATUSES)
  status!: AdminTriageStatus;
}
