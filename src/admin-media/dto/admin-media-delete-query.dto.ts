import { IsNotEmpty, IsString } from 'class-validator';

// Admin `DELETE /admin/media` query. Same `{ key }` shape as
// `AdminMediaHeadQueryDto`, kept a distinct class so the destructive route's
// contract reads honestly at the call site rather than borrowing the head
// endpoint's DTO. `AdminMediaService.delete` re-validates the key against the
// known-key posture before the object is touched.
export class AdminMediaDeleteQueryDto {
  @IsString()
  @IsNotEmpty()
  key!: string;
}
