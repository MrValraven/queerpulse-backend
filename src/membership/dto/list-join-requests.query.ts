import { IsEnum, IsOptional } from 'class-validator';
import { JoinRequestStatus } from '../entities/join-request.entity';

export class ListJoinRequestsQuery {
  @IsOptional()
  @IsEnum(JoinRequestStatus)
  status?: JoinRequestStatus;
}
