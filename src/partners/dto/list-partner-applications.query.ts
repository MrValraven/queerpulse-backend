import { IsIn, IsOptional } from 'class-validator';

/**
 * `GET /admin/partners/applications` — OPS-04's "Assigned to me" filter for
 * the partner-application queue.
 *
 * A closed set rather than a user id, for the same reason the join-request and
 * verification queues take one: the queue only ever needs "mine" and
 * "nobody's", and accepting an arbitrary id would turn a filter into a way to
 * enumerate what a named colleague is working on. `me` is resolved from the
 * session in the controller.
 */
export class ListPartnerApplicationsQuery {
  @IsOptional()
  @IsIn(['me', 'unassigned'])
  assignedTo?: 'me' | 'unassigned';
}
