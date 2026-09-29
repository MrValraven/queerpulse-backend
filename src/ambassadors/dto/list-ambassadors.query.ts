import { IsIn, IsOptional } from 'class-validator';

export const AMBASSADOR_LIST_STATUSES = ['active', 'past'] as const;
export type AmbassadorListStatus = (typeof AMBASSADOR_LIST_STATUSES)[number];

/** Query for `GET /admin/ambassadors`. Absent reads as `active`. */
export class ListAmbassadorsQuery {
  @IsOptional()
  @IsIn(AMBASSADOR_LIST_STATUSES)
  status?: AmbassadorListStatus;
}
