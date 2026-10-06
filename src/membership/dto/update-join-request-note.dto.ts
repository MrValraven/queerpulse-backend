import { IsString, MaxLength } from 'class-validator';

/**
 * Body of `PATCH /admin/join-requests/:id/note`: the staff-only internal note
 * on a DECLINED request, replacing whatever was there.
 *
 * `note` is always required, and an empty (or whitespace-only) string is the
 * way to clear it: the service stores blank as NULL and wipes the
 * last-edited stamp with it. One field for both edit and clear keeps the
 * frontend to a single textarea and a single save.
 *
 * The 2000-character cap is measured on the raw input, before the service
 * strips markup and trims, so the stored value can only be shorter.
 */
export class UpdateJoinRequestNoteDto {
  @IsString()
  @MaxLength(2000)
  note!: string;
}
