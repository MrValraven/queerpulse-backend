import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Min } from 'class-validator';
import { ConnectionTab } from '../connections.service';

/** `GET /connections?tab=&page=` query params (`getConnections` in the FE). */
export class ListConnectionsQuery {
  @IsOptional()
  @IsIn(['all', 'incoming', 'outgoing', 'vouched'])
  tab?: ConnectionTab;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;
}
