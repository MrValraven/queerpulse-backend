import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * `PATCH /admin/landlords/intro-requests/:id` body.
 *
 * `reason` is the LOC-19 addition and it is the point of the change: the
 * requester is now told the answer, so a decline with no sentence attached
 * would be a notification that says only "no" to somebody who asked to be
 * introduced to a landlord. The service REQUIRES it on `declined` and leaves
 * it optional on `accepted`, where it becomes the "here is what happens next"
 * line. Whitespace-only text is normalised to null there and then refused
 * where it was required.
 */
export class TriageIntroRequestDto {
  @IsIn(['accepted', 'declined'])
  action!: 'accepted' | 'declined';

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}
