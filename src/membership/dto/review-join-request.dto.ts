import { IsIn } from 'class-validator';
import { JoinRequestStatus } from '../entities/join-request.entity';

export class ReviewJoinRequestDto {
  @IsIn([JoinRequestStatus.Approved, JoinRequestStatus.Declined])
  status: JoinRequestStatus.Approved | JoinRequestStatus.Declined;
}
