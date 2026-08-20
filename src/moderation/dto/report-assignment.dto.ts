import { IsBoolean } from 'class-validator';

// `PATCH /mod/reports/:id/assignment` body — self-assign (`assign: true`) or
// unassign (`assign: false`) a report (COM-5). No "assign to someone else":
// the queue's "Assigned to me" filter only needs a claim/release action by the
// caller themselves.
export class ReportAssignmentDto {
  @IsBoolean()
  assign!: boolean;
}
