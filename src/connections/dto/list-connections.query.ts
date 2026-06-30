import { IsIn, IsOptional } from 'class-validator';
import { ConnectionTab } from '../connections.service';

export class ListConnectionsQuery {
  @IsOptional()
  @IsIn(['all', 'incoming', 'outgoing', 'vouched'])
  tab?: ConnectionTab;
}
