import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Min } from 'class-validator';
import {
  INQUIRY_KINDS,
  INQUIRY_STATUSES,
  InquiryKind,
  InquiryStatus,
} from '../entities/inquiry.entity';

/**
 * `GET /inquiries?kind=&status=&page=` — the admin triage list.
 *
 * Deliberately the same shape as `ListIntakesQuery`: the console reads both
 * inboxes side by side, and one paging idiom (page number + a
 * `{items,total,page,pageSize}` envelope) is one thing for the frontend to
 * implement rather than two. Page SIZE is not a query param anywhere in this
 * repo — it is the shared `PAGE_SIZE` constant — so it is not one here either.
 */
export class ListInquiriesQuery {
  @IsOptional()
  @IsIn(INQUIRY_KINDS)
  kind?: InquiryKind;

  @IsOptional()
  @IsIn(INQUIRY_STATUSES)
  status?: InquiryStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;
}
