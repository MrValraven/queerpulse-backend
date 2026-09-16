import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

/**
 * ENG-245: the optional body of `DELETE /conversations/:id/messages/:messageId`.
 *
 * Every field is optional and only read on the STAFF branch (a moderator or
 * admin deleting someone else's message), where it lands on the
 * `message_deleted_by_staff` audit row. An author deleting their own message
 * sends nothing, and anything they do send is ignored. An empty body stays
 * valid, so every existing client keeps working unchanged.
 */
export class DeleteMessageDto {
  /** The moderation reason the staff member is citing, when there is one. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  reasonCode?: string;

  /** A free-text note for the audit trail. */
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;

  /** The report this takedown answers, when it answers one. Must name this
   *  exact message (`REPORT_SUBJECT_MISMATCH` otherwise). */
  @IsOptional()
  @IsUUID()
  reportId?: string;
}
