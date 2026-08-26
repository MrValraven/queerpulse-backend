import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * `DELETE /admin/landlords/:id?reason=` query.
 *
 * The reason rides in the query string rather than a body because a DELETE
 * body is not reliably carried by every client, and this one has to reach the
 * member who suggested the entry: removing a suggestion is the harshest of the
 * three landlord decisions, and it is the one most owed an explanation. The
 * service REQUIRES it whenever there is a submitter to tell, and ignores its
 * absence on a staff-created entry, which has nobody to notify.
 */
export class RemoveLandlordQuery {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}
