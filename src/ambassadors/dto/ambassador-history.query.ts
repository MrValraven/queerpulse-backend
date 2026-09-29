import { IsUUID } from 'class-validator';

/** Query for `GET /admin/ambassadors/history`: the member whose grants to list. */
export class AmbassadorHistoryQuery {
  @IsUUID()
  userId!: string;
}
