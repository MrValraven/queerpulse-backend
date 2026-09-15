import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

// `POST /admin/forum/threads/:slug/review` body — a moderator's verdict on a
// thread its author held back (`CreateThreadDto.submitForReview`).
export class ReviewThreadDto {
  // The verb the reviewer performs, NOT the `review_state` it writes. A DTO
  // that accepted 'approved'/'rejected' would be spelling the column, and the
  // column has a fourth value (NULL, never submitted) that no request may ever
  // set. `@IsIn` rather than `@IsString` for the same reason the composer's
  // `kind` is a closed vocabulary: a third verb is a product decision that has
  // to land in the console and the service together.
  @IsIn(['approve', 'reject'])
  decision!: 'approve' | 'reject';

  // The reviewer's optional word to the author, carried on the notification
  // they receive. 280 characters, matching `LockThreadDto.reason`: it is a
  // sentence explaining a decision, and anything longer is a conversation,
  // which belongs in a message rather than in a verdict.
  //
  // Optional on an APPROVAL, where there is usually nothing to add, and merely
  // optional rather than required on a rejection: a required note reads well
  // until the one case where the honest answer is already in the thread, and a
  // reviewer forced to type something types "no".
  @IsOptional()
  @IsString()
  @MaxLength(280)
  note?: string;
}
