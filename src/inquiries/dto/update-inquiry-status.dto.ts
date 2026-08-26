import { IsIn } from 'class-validator';
import { INQUIRY_STATUSES, InquiryStatus } from '../entities/inquiry.entity';

/**
 * Body for `PATCH /inquiries/:id` — the admin triage action.
 *
 * Both states are valid targets here, unlike the intake worklist: `handled` is
 * "someone took this", and `new` is a genuine re-open, which an admin needs
 * when a message was closed by mistake. Re-opening also CLEARS the handler
 * stamp (see `InquiriesService.updateStatus`) — a re-opened inquiry has no
 * handler, and leaving a stale name on it would read as "already dealt with".
 *
 * The global `ValidationPipe` (`whitelist` + `forbidNonWhitelisted`) rejects
 * any other top-level key.
 */
export class UpdateInquiryStatusDto {
  @IsIn(INQUIRY_STATUSES)
  status!: InquiryStatus;
}
