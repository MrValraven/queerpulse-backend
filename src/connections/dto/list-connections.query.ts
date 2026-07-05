import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { ConnectionTab } from '../connections.service';

export class ListConnectionsQuery {
  @IsOptional()
  @IsIn(['all', 'incoming', 'outgoing', 'vouched'])
  tab?: ConnectionTab;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
}
