import { IsBoolean } from 'class-validator';

/**
 * Body of every `PATCH .../:id/assignment` route (OPS-04) — self-assign
 * (`assign: true`) or release (`assign: false`).
 *
 * Byte-for-byte the shape of `ReportAssignmentDto`, on purpose: four queues
 * that behave identically should not each invent their own request body. Like
 * that one, there is deliberately no "assign it to someone else" field. A
 * queue needs a claim and a release so two people do not work the same row;
 * handing work to a third person is a conversation, not an API call.
 */
export class QueueAssignmentDto {
  @IsBoolean()
  assign!: boolean;
}
